const puppeteer = require('puppeteer');
const { exec } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const path = require('path');
const yargs = require('yargs');

const execAsync = promisify(exec);

// 分辨率定义
const RESOLUTIONS = {
    'm': { width: 1280, height: 720, name: '标清' },      // 标清
    'h': { width: 1920, height: 1080, name: '高清' },     // 高清 (默认)
    'q': { width: 3840, height: 2160, name: '超高清' }    // 超高清
};

const DEFAULT_RESOLUTION = 'h'; // 默认高清

function generateTimestamp() {
    const now = new Date();
    return now.toISOString()
        .replace(/-/g, '')     // Remove all hyphens
        .replace(/[:.]/g, '')  // Remove colons and dots
        .replace('T', '')      // Remove T
        .replace('Z', '');     // Remove Z
}

function getUniqueFilename(originalPath, extension) {
    const dir = path.dirname(originalPath);
    const basename = path.basename(originalPath, path.extname(originalPath));
    const timestamp = generateTimestamp();
    return path.join(dir, `${basename}_${timestamp}.${extension}`);
}

async function getSVGDimensions(page) {
    const dimensions = await page.evaluate(() => {
        const svg = document.querySelector('svg');
        if (!svg) return null;

        // Try to get dimensions from viewBox first
        const viewBox = svg.getAttribute('viewBox');
        if (viewBox) {
            const [x, y, width, height] = viewBox.split(' ').map(Number);
            if (!isNaN(width) && !isNaN(height)) {
                return { width, height };
            }
        }

        // Try width and height attributes
        let width = svg.getAttribute('width');
        let height = svg.getAttribute('height');

        // Convert percentage to pixels based on parent container
        if (width && width.endsWith('%')) {
            width = svg.parentElement.clientWidth * (parseFloat(width) / 100);
        } else if (width) {
            width = parseFloat(width);
        }

        if (height && height.endsWith('%')) {
            height = svg.parentElement.clientHeight * (parseFloat(height) / 100);
        } else if (height) {
            height = parseFloat(height);
        }

        // If explicit dimensions are found, use them
        if (!isNaN(width) && !isNaN(height)) {
            return { width, height };
        }

        // Fallback to getBBox() for intrinsic size
        const bbox = svg.getBBox();
        return {
            width: Math.ceil(bbox.width),
            height: Math.ceil(bbox.height)
        };
    });

    return dimensions || { width: 1920, height: 1080 }; // Default dimensions if nothing is found
}

function calculateScaleToFitTarget(originalWidth, originalHeight, targetWidth, targetHeight) {
    // 计算缩放到目标分辨率所需的独立缩放比例
    const scaleX = targetWidth / originalWidth;
    const scaleY = targetHeight / originalHeight;

    // 使用较大的缩放比例，确保两个维度都至少达到目标尺寸
    return Math.max(scaleX, scaleY);
}

function ensureEvenDimensions(width, height) {
    return {
        width: Math.floor(width / 2) * 2,
        height: Math.floor(height / 2) * 2
    };
}

async function delay(time) {
    return new Promise(function(resolve) {
        setTimeout(resolve, time)
    });
}

async function generateMOVWithAlpha(framesDir, outputPath, fps, width, height) {
    // 使用 ProRes 4444 编码器支持透明通道
    const command = `ffmpeg -r ${fps} -i "${framesDir}/frame-%04d.png" -y -c:v prores_ks -pix_fmt yuva444p10le -profile:v 4444 -vendor ap10 -movflags +faststart "${outputPath}"`;

    console.log('MOV Spawned FFmpeg with command:', command);

    try {
        const { stdout, stderr } = await execAsync(command);
        console.log('MOV conversion finished');
    } catch (error) {
        console.error('MOV Error:', error);
        console.error('FFmpeg Error:', error.stderr);
        throw error;
    }
}

async function generateMP4(framesDir, outputPath, fps, width, height) {
    const command = `ffmpeg -r ${fps} -i "${framesDir}/frame-%04d.png" -y -vcodec libx264 -pix_fmt yuv420p -movflags +faststart -preset medium -crf 23 -profile:v main -tune animation -maxrate 2M -bufsize 4M -vf "scale=${width}:${height}" "${outputPath}"`;

    console.log('MP4 Spawned FFmpeg with command:', command);

    try {
        const { stdout, stderr } = await execAsync(command);
        console.log('MP4 conversion finished');
    } catch (error) {
        console.error('MP4 Error:', error);
        console.error('FFmpeg Error:', error.stderr);
        throw error;
    }
}

async function createSVGHTMLWrapper(svgContent, transparentBg = true) {
    const bgStyle = transparentBg ? "background: transparent;" : "";

    return `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <title>SVG Animation</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            display: flex;
            justify-content: center;
            align-items: center;
            ${bgStyle}
            width: 100vw;
            height: 100vh;
            overflow: hidden;
        }
        #svg-container {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
        }
        svg {
            max-width: 100%;
            max-height: 100%;
            width: auto;
            height: auto;
        }
    </style>
</head>
<body>
    <div id="svg-container">
        ${svgContent}
    </div>
</body>
</html>`;
}

async function captureAnimation({svgUrl, outputPath, deviceScaleFactor, fps, duration, resolution, format = 'mov'}) {

    // Create output directory if it doesn't exist
    const screenshotsDir = path.join(__dirname, 'screenshots');
    if (!fs.existsSync(screenshotsDir)) {
        fs.mkdirSync(screenshotsDir);
    }

    const browser = await puppeteer.launch();
    const page = await browser.newPage();

    // 读取SVG文件内容并创建HTML包装
    let svgContent;
    if (svgUrl.startsWith('file://')) {
        const svgFilePath = svgUrl.replace('file://', '');
        svgContent = fs.readFileSync(svgFilePath, 'utf8');
    } else {
        // 对于URL，直接导航（保持原有逻辑）
        await page.goto(svgUrl, { waitUntil: 'networkidle0' });
    }

    // 如果读取了SVG内容，创建临时HTML文件
    if (svgContent) {
        const htmlContent = await createSVGHTMLWrapper(svgContent, true);
        const tempHtmlPath = path.join(__dirname, 'temp_svg_preview.html');
        fs.writeFileSync(tempHtmlPath, htmlContent);

        await page.goto(`file://${tempHtmlPath}`, { waitUntil: 'networkidle0' });

        // 页面加载完成后删除临时文件
        await page.evaluate(() => {});
        fs.unlinkSync(tempHtmlPath);
    }

    // 等待SVG加载完成
    await page.waitForSelector('svg', { timeout: 10000 });

    // 应用CSS样式确保SVG正确显示
    await page.evaluate(() => {
        const svg = document.querySelector('svg');
        if (svg) {
            // 确保SVG使用正确的显示方式
            svg.style.display = 'block';
            svg.style.maxWidth = '100%';
            svg.style.maxHeight = '100%';
            svg.style.width = 'auto';
            svg.style.height = 'auto';
        }
    });

    // Get SVG dimensions
    const dimensions = await getSVGDimensions(page);
    const originalDimensions = { ...dimensions };

    console.log(`Detected SVG dimensions: ${dimensions.width}x${dimensions.height}`);

    // 获取目标分辨率
    const targetResolution = RESOLUTIONS[resolution] || RESOLUTIONS[DEFAULT_RESOLUTION];
    console.log(`Target resolution: ${targetResolution.name} (${targetResolution.width}x${targetResolution.height})`);

    // 检查是否需要放大到目标分辨率
    let upscaleToTarget = false;
    let upscaleScale = 1;

    if (dimensions.width < targetResolution.width || dimensions.height < targetResolution.height) {
        upscaleToTarget = true;
        // 使用新的缩放计算，确保达到目标分辨率
        upscaleScale = calculateScaleToFitTarget(dimensions.width, dimensions.height, targetResolution.width, targetResolution.height);

        console.log(`SVG is smaller than target resolution`);
        console.log(`Auto-upscaling with scale factor: ${upscaleScale.toFixed(2)}`);

        // 应用放大
        dimensions.width = Math.floor(dimensions.width * upscaleScale);
        dimensions.height = Math.floor(dimensions.height * upscaleScale);

        // 确保至少达到目标尺寸
        dimensions.width = Math.max(dimensions.width, targetResolution.width);
        dimensions.height = Math.max(dimensions.height, targetResolution.height);
    }

    // 确保尺寸为偶数
    dimensions.width = Math.floor(dimensions.width / 2) * 2;
    dimensions.height = Math.floor(dimensions.height / 2) * 2;

    if (deviceScaleFactor != 1) {
        console.log(`Using device scale factor: ${deviceScaleFactor}`);
    }

    // Calculate final dimensions with device scale factor
    const finalWidth = Math.floor(dimensions.width * deviceScaleFactor / 2) * 2;
    const finalHeight = Math.floor(dimensions.height * deviceScaleFactor / 2) * 2;

    console.log(`Final output dimensions: ${finalWidth}x${finalHeight}`);

    if (upscaleToTarget) {
        console.log(`Upscaled from ${originalDimensions.width}x${originalDimensions.height} to ${finalWidth}x${finalHeight}`);

        // 检查是否确实达到了目标分辨率
        if (finalWidth >= targetResolution.width && finalHeight >= targetResolution.height) {
            console.log(`✓ Successfully reached target resolution (${targetResolution.width}x${targetResolution.height})`);
        } else {
            console.log('⚠ Warning: Could not reach full target resolution');
        }
    }

    // 设置视口 - 使用计算后的尺寸
    await page.setViewport({
        width: Math.ceil(dimensions.width),
        height: Math.ceil(dimensions.height),
        deviceScaleFactor: deviceScaleFactor
    });

    console.log(`Detected animation duration: ${duration}ms`);

    // Capture frames
    const frames = [];
    const totalFrames = Math.ceil((duration / 1000) * fps);
    const frameInterval = duration / totalFrames;

    console.log(`Capturing ${totalFrames} frames at ${fps} FPS...`);
    console.log(`Frame interval: ${frameInterval}ms`);

    // 重置并开始动画
    await page.evaluate(() => {
        document.querySelectorAll('*').forEach(element => {
            const animations = element.getAnimations();
            animations.forEach(animation => {
                animation.cancel();
            });
        });
    });

    let currentTime = 0;
    for (let i = 0; i < totalFrames; i++) {
        // 优先使用 SVG 的 setCurrentTime 方法
        await page.evaluate((time) => {
            const svg = document.querySelector('svg');
            if (svg && typeof svg.setCurrentTime === 'function') {
                svg.setCurrentTime(time / 1000);
            }
        }, currentTime);

        // 备用方法：设置 CSS 动画时间
        await page.evaluate((time) => {
            document.querySelectorAll('*').forEach(element => {
                const animations = element.getAnimations();
                animations.forEach(animation => {
                    animation.currentTime = time;
                });
            });
        }, currentTime);

        await delay(50); // 确保渲染完成

        const framePath = path.join(screenshotsDir, `frame-${i.toString().padStart(4, '0')}.png`);
        await page.screenshot({
            path: framePath,
            type: 'png',
            omitBackground: true,
            clip: {
                x: 0,
                y: 0,
                width: dimensions.width,
                height: dimensions.height
            }
        });
        frames.push(framePath);

        currentTime += frameInterval;
        const progress = Math.round((i / totalFrames) * 100);
        process.stdout.write(`\rProgress: ${progress}%`);
    }

    await browser.close();

    // Generate unique filename for output
    const outputFilePath = getUniqueFilename(outputPath, format);

    console.log(' ');
    console.log('------ Output Information ------');
    console.log(`Output: ${outputFilePath}`);
    console.log(`Format: ${format.toUpperCase()} with alpha channel (transparent background)`);
    console.log('---------------------------------');
    console.log(' ');

    // Convert frames to video
    try {
        if (format === 'mov') {
            await generateMOVWithAlpha(screenshotsDir, outputFilePath, fps, finalWidth, finalHeight);
        } else {
            await generateMP4(screenshotsDir, outputFilePath, fps, finalWidth, finalHeight);
        }

        // Clean up screenshots
        frames.forEach(frame => {
            if (fs.existsSync(frame)) {
                fs.unlinkSync(frame);
            }
        });
        if (fs.existsSync(screenshotsDir)) {
            fs.rmdirSync(screenshotsDir);
        }

        console.log('Conversion completed successfully!');
        if (format === 'mov') {
            console.log('The video has transparent background and can be used in video editors like CapCut, Filmora, etc.');
        }
    } catch (error) {
        console.error('Conversion error:', error);
        if (fs.existsSync(screenshotsDir)) {
            frames.forEach(frame => {
                if (fs.existsSync(frame)) {
                    fs.unlinkSync(frame);
                }
            });
            fs.rmdirSync(screenshotsDir);
        }
        throw error;
    }
}

async function main() {
    try {
        const argv = yargs
            .option('svg', {
                alias: 's',
                description: 'Path to the SVG file',
                type: 'string',
            })
            .option('output', {
                alias: 'o',
                description: 'Path to save the output',
                type: 'string',
                default: process.cwd(),
            })
            .option('fps', {
                alias: 'f',
                description: 'Frames per second',
                type: 'number',
                default: 30,
            })
            .option('scale', {
                alias: 'c',
                description: 'Device scale factor for rendering',
                type: 'number',
                default: 1,
            })
            .option('duration', {
                alias: 'd',
                description: 'Duration for animation',
                type: 'number',
                default: 10,
            })
            .option('format', {
                alias: 't',
                description: 'Output format (mov|mp4)',
                type: 'string',
                choices: ['mov', 'mp4'],
                default: 'mov',
            })
            .option('m', {
                description: '标清输出 (1280x720)',
                type: 'boolean',
            })
            .option('h', {
                description: '高清输出 (1920x1080) - 默认',
                type: 'boolean',
            })
            .option('q', {
                description: '超高清输出 (3840x2160)',
                type: 'boolean',
            })
            .conflicts('m', 'h')
            .conflicts('m', 'q')
            .conflicts('h', 'q')
            .help()
            .alias('help', 'help')
            .argv;

        // 检查是否提供了SVG文件路径
        let svgPath = argv.svg;

        // 如果没有提供--svg参数，检查是否有未标记的参数
        if (!svgPath && argv._.length > 0) {
            svgPath = argv._[0];
        }

        // 如果仍然没有SVG路径，报错
        if (!svgPath) {
            console.error('Error: No SVG file specified. Please provide an SVG file path.');
            console.error('Usage: node index.js [--options] <svg-file-path>');
            process.exit(1);
        }

        // 检查文件扩展名
        if (!svgPath.toLowerCase().endsWith('.svg')) {
            console.error('Error: The specified file is not an SVG file.');
            process.exit(1);
        }

        const outputBasePath = argv.output;
        const fps = argv.fps;
        const deviceScaleFactor = argv.scale;
        const duration = argv.duration;
        const format = argv.format;

        // 确定分辨率
        let resolution = DEFAULT_RESOLUTION;
        if (argv.m) resolution = 'm';
        else if (argv.q) resolution = 'q';
        else if (argv.h) resolution = 'h';

        const svgUrl = svgPath.startsWith('http') ? svgPath : `file://${path.resolve(svgPath)}`;

        let finalOutputBasePath = outputBasePath;
        if (outputBasePath === process.cwd()) {
            finalOutputBasePath = path.join(process.cwd(), path.basename(svgPath, '.svg'));
        }

        // 获取分辨率信息
        const resolutionInfo = RESOLUTIONS[resolution];

        console.log('------ Input Information ------');
        console.log(`Input SVG: ${svgUrl}`);
        console.log(`Output Base Path: ${finalOutputBasePath}`);
        console.log(`FPS: ${fps}`);
        console.log(`Device Scale Factor: ${deviceScaleFactor}`);
        console.log(`Resolution: ${resolutionInfo.name} (${resolutionInfo.width}x${resolutionInfo.height})`);
        console.log(`Format: ${format.toUpperCase()} with ${format === 'mov' ? 'transparent background' : 'standard background'}`);
        console.log('-------------------------------');
        console.log(' ');

        await captureAnimation({
            svgUrl: svgUrl,
            outputPath: finalOutputBasePath,
            fps: fps,
            deviceScaleFactor: deviceScaleFactor,
            duration: duration*1000,
            resolution: resolution,
            format: format
        });
    } catch (error) {
        console.error('Error capturing animation:', error);
        process.exit(1);
    }
}

if (require.main === module) {
    main();
}
