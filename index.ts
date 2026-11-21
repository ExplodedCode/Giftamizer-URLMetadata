import express, { Response } from 'express';
import bodyParser from 'body-parser';

import { Browser, Page } from 'puppeteer';
import puppeteer from 'puppeteer-extra';
import createPuppeteerStealth from 'puppeteer-extra-plugin-stealth';
import { PuppeteerBlocker } from '@ghostery/adblocker-puppeteer';
import fetch from 'cross-fetch'; // required for PuppeteerBlocker

import UserAgent from 'user-agents';

import fs from 'fs';
import path from 'path';

import axios from 'axios';
import sharp from 'sharp';
import UI from './UI';

const puppeteerStealth = createPuppeteerStealth();
puppeteerStealth.enabledEvasions.delete('user-agent-override');
puppeteer.use(puppeteerStealth);

require('dotenv').config();
const configPath = process.env.HOME_OVERRIDE ? process.env.HOME_OVERRIDE : process.env.HOME ? path.join(String(process.env.HOME)) : './config';
if (!fs.existsSync(configPath)) {
	console.log('Creating config folder...', configPath);
	fs.mkdirSync(configPath);
}

const errorsPath = path.join(configPath, 'errors');
if (!fs.existsSync(errorsPath)) {
	console.log('Creating errors folder...', errorsPath);
	fs.mkdirSync(errorsPath, { recursive: true });
}

class BrowserManager {
	urlQueue: string[] = [];

	async captureSnapshot(page: Page) {
		const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

		// get page snapshot
		const cdp = await page.target().createCDPSession();
		const { data: pageSnapshot } = await cdp.send('Page.captureSnapshot', { format: 'mhtml' });
		fs.writeFileSync(path.join(errorsPath, `${timestamp}-snapshot.mhtml`), pageSnapshot);

		// get page screenshot
		await page.screenshot({ path: path.join(errorsPath, `${timestamp}-screenshot.png`), encoding: 'base64' });
	}

	async enqueue(url: string, res: Response) {
		this.urlQueue.push(url);

		const browser = await puppeteer.launch({
			executablePath: undefined,
			targetFilter: (target: any) => target.type() !== 'other',
			args: ['--window-size=1600,1200', '--no-sandbox', '--disable-setuid-sandbox', '--font-render-hinting=none'],
			headless: true,
		});
		console.log('Browser launched');

		console.log('Load images for... ' + url);

		// initialize page
		const [page] = await browser.pages();
		PuppeteerBlocker.fromPrebuiltAdsAndTracking(fetch).then((blocker) => {
			blocker.enableBlockingInPage(page);
		});

		await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36');

		if (this.urlQueue.length > 0) {
			const url = this.urlQueue.shift();
			let response: any = {
				url: url,
				images: [],
			};

			// if amazon link
			if (url.startsWith('https://www.amazon.com') || url.startsWith('https://amazon.com') || url.startsWith('https://a.co') || url.startsWith('https://amzn.to')) {
				try {
					const cloudflareAmazonWorker = (await axios.get(`https://giftamizer-amazon.explodedcode.workers.dev`, { params: { url: url } })).data;

					response.title = cloudflareAmazonWorker.title;
					response.description = cloudflareAmazonWorker.description;
					response.price = cloudflareAmazonWorker.price;
					response.images = cloudflareAmazonWorker.images;

					console.log({
						title: response.title,
						description: response.description,
						price: response.price,
						images: response.images.length,
					});

					// convert urls to base64 images
					let imagesBase64 = [];
					for (let index = 0; index < response.images.length; index++) {
						const img = response.images[index];
						try {
							imagesBase64.push(await getImageAsBase64(img));
						} catch (e) {}
					}
					response.images = imagesBase64;

					await browser.close();

					res.send(response);
				} catch (error) {
					await browser.close();

					console.log(error);
					res.status(400).send({ error: 'Product not found' });
				}
			} else {
				try {
					try {
						await page.goto(url, {
							waitUntil: 'networkidle0',
							timeout: 5000,
						});
					} catch {}

					await delay(1000); // wait for 1000ms

					await autoScroll(page, 10); // set limit to 50 scrolls
					await delay(500); // wait for 500ms
					await page.evaluate(() => {
						// scroll to top
						window.scroll(0, 0);
					});

					// get page title
					try {
						response.title = (await page.$eval('title', (element) => element.innerHTML)).trim();
					} catch (e) {}

					// Fuck walmart
					if (response.title === 'Robot or human?' && url.includes('walmart.com')) {
						throw new Error('Blocked by robot verification');
					}

					// get page description
					try {
						response.description = (await page.$eval('meta[name="description"]', (element) => element.getAttribute('content'))).trim();
					} catch (e) {}

					// get item price
					try {
						const content = await page.$eval('body', (element) => {
							return element.textContent;
						});

						const getPrice = (content: string) => {
							const regex = /\$(\s+?)?\d+(.\d{1,2})/gm;
							let m;
							while ((m = regex.exec(content)) !== null) {
								// This is necessary to avoid infinite loops with zero-width matches
								if (m.index === regex.lastIndex) {
									regex.lastIndex++;
								}

								let groupIndex = 0;
								for (const match of m) {
									if (groupIndex === 0) {
										const price = parseFloat(match.replace(/[^\d.]/g, ''));

										if (price > 0) {
											return match;
										}
									}
									groupIndex++;
								}
							}
						};
						response.price = getPrice(content);
					} catch (e) {}

					// get first image
					try {
						const img = (await page.$eval('meta[property="og:image"]', (element) => element.getAttribute('content'))).trim();
						if (img.length > 0 && img.startsWith('http')) {
							response.images = [img];
						}
					} catch (e) {}

					try {
						try {
							const imgSrcs = [];
							const imgs = await page.$$('::-p-xpath(//img[not(ancestor::header)])');
							let index = 0;
							for (let img of imgs) {
								let src = String(await (await img.getProperty('src')).jsonValue());
								const rect = await img.boundingBox();

								const minImageSize = 120;
								if (
									rect && // check if image is too small
									(rect.width > minImageSize || rect.height > minImageSize) &&
									// check path is valid
									src.trim().length > 0 &&
									src.startsWith('http') &&
									!src.includes('.svg') &&
									!imgSrcs.includes(src)
								) {
									if (index > 10) break; // limit images to 10
									imgSrcs.push(src);
									index++;
								}
							}

							response.images = response.images.concat(imgSrcs);
						} catch (e) {
							console.log('Error getting image URLs.', e);
						}

						// convert urls to base64 images
						let imagesBase64 = [];
						for (let index = 0; index < response.images.length; index++) {
							const img = response.images[index];
							try {
								imagesBase64.push(await getImageAsBase64(img));
							} catch (e) {}
						}
						response.images = imagesBase64;
					} catch (e) {}

					// append page screenshot to the end
					const screenshot = await page.screenshot();
					let resizedImageBuf = await sharp(screenshot);
					// resize if larger than 1000px in any direction
					const metadata = await resizedImageBuf.metadata();
					if (metadata.height > 1000 || metadata.width > 1000) {
						resizedImageBuf = resizedImageBuf.resize(1000);
					}
					// convert to base64
					const base64 = (await resizedImageBuf.toBuffer()).toString('base64');
					response.images = response.images.concat('data:image/jpeg;base64,' + base64);

					// remove duplicates
					response.images = response.images.filter(function (item: any, pos: number) {
						return response.images?.indexOf(item) == pos;
					});

					// close page
					await page.close();

					// console.log(response);
					res.send(response);
				} catch (error) {
					await this.captureSnapshot(page);
					await page.close();

					console.log(error);
					res.status(400).send({ error: 'Product not found' });
				}
			}
		}
	}
}

const browserManager = new BrowserManager();

const app = express();
const port = 5501;

// Body Parser Middleware
app.use(bodyParser.json());

app.post('/', async (req, res) => {
	try {
		const url = String(req.body.url).trim();
		if (url.length > 0 && url.startsWith('http')) {
			browserManager.enqueue(url, res);
		} else {
			res.status(400).send({ error: 'No url provided' });
		}
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

app.get('/', async (req, res) => {
	try {
		res.send(UI);
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

app.get('/errors', async (req, res) => {
	try {
		const files = await fs.promises.readdir(path.join(__dirname, 'errors'));

		// Delete files older than 2 weeks
		const twoWeeksAgo = new Date();
		twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

		for (const file of files) {
			const filePath = path.join(__dirname, 'errors', file);
			const stats = await fs.promises.stat(filePath);

			if (stats.mtime < twoWeeksAgo) {
				await fs.promises.unlink(filePath);
			}
		}

		// Get updated file list after deletions
		const errorFiles = await fs.promises.readdir(path.join(__dirname, 'errors'));

		const html = `
                        <html>
                                <body>
                                        <h1>Error Screenshots</h1>
                                        <ul>
                                                ${errorFiles.map((file) => `<li><a href="/errors/${file}">${file}</a></li>`).join('')}
                                        </ul>
                                </body>
                        </html>
                `;
		res.send(html);
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

app.get('/errors/:filename', async (req, res) => {
	try {
		const filename = req.params.filename;
		res.sendFile(`${__dirname}/errors/${filename}`);
	} catch (error) {
		res.status(500).send('ERROR! - ' + error.message);
	}
});

app.listen(port, () => {
	return console.log(`Express is listening at http://localhost:${port}`);
});

const delay = (ms) => new Promise((res) => setTimeout(res, ms));

async function autoScroll(page, maxScrolls) {
	await page.evaluate(async (maxScrolls) => {
		await new Promise((resolve) => {
			var totalHeight = 0;
			var distance = 1000;
			var scrolls = 0; // scrolls counter
			var timer = setInterval(() => {
				var scrollHeight = document.body.scrollHeight;
				window.scrollBy(0, distance);
				totalHeight += distance;
				scrolls++; // increment counter

				// stop scrolling if reached the end or the maximum number of scrolls
				if (totalHeight >= scrollHeight - window.innerHeight || scrolls >= maxScrolls) {
					clearInterval(timer);
					resolve(true);
				}
			}, 25);
		});
	}, maxScrolls); // pass maxScrolls to the function
}

const imageSize = 1000;
async function getImageAsBase64(imageUrl: string): Promise<string> {
	return new Promise(async (resolve, reject) => {
		try {
			const userAgent = new UserAgent({ deviceCategory: 'desktop' });
			const randomUserAgent = userAgent.toString();

			const response = await axios.get(imageUrl, {
				responseType: 'arraybuffer',
				headers: {
					'User-Agent': randomUserAgent,
				},
			});

			// Create base blurred background
			const background = sharp(response.data)
				.resize(imageSize, imageSize, {
					fit: 'cover',
					position: 'center',
				})
				.blur(30); // Optionally add a blur to the background for effect.

			// Create the overlay image by resizing to fit within 1000x1000 and keeping aspect ratio
			const overlay = sharp(response.data).resize(imageSize, imageSize, {
				fit: 'inside',
				position: 'center',
			});

			// Composite the images
			const compositeImage = await sharp({
				create: {
					width: imageSize,
					height: imageSize,
					channels: 4,
					background: { r: 0, g: 0, b: 0, alpha: 1 }, // Black transparent background
				},
			})
				.composite([{ input: await background.toBuffer() }, { input: await overlay.toBuffer(), blend: 'over' }])
				.jpeg()
				.toBuffer();

			// convert to base64
			const base64 = compositeImage.toString('base64');
			resolve(`data:image/jpg;base64,${base64}`);
		} catch (error) {
			console.log(`Error converting image to base64: ${imageUrl}`, error);
			reject(error);
		}
	});
}
