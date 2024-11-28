import * as vscode from "vscode"
import * as fs from "fs/promises"
import * as path from "path"
import { Browser, Page, ScreenshotOptions, TimeoutError, launch, connect } from "puppeteer"
import pWaitFor from "p-wait-for"
import delay from "delay"
import { fileExistsAtPath } from "../../utils/fs"
import { BrowserActionResult } from "../../shared/ExtensionMessage"

export class BrowserSession {
	private context: vscode.ExtensionContext
	private browser?: Browser
	private page?: Page
	private currentMousePosition?: string
	private isInteractive: boolean = false
	private browserPort: string = '7333'

	constructor(context: vscode.ExtensionContext) {
		this.context = context
	}

	async launchBrowser(interactive: boolean = false, port?: string) {
		console.log("launch browser called")
		this.isInteractive = interactive

		// Set browserPort if provided, otherwise use default
		if (port) {
			this.browserPort = port
		}

		if (this.browser) {
			await this.closeBrowser() // this may happen when the model launches a browser again after having used it already before
		}

		if (this.isInteractive) {
			try {
				// Fetch the WebSocket endpoint from Chrome's debugging API
				const response = await fetch(`http://127.0.0.1:${this.browserPort}/json/version`)
				const data = await response.json()
				const browserWSEndpoint = data.webSocketDebuggerUrl
	
				if (!browserWSEndpoint) {
					throw new Error(`BrowserSession.ts :: launchBrowser :: Could not get webSocketDebuggerUrl from Chrome debugging API, port: ${this.browserPort}`)
				}
	
				this.browser = await connect({
					browserWSEndpoint,
				})
			} catch (error) {
				console.error("BrowserSession.ts :: launchBrowser :: Failed to connect to browser, make sure you have a running browser with --remote-debugging-port=7333", error)
				throw new Error(`BrowserSession.ts :: launchBrowser :: Failed to connect to browser: ${error.message}, make sure you have a running browser with --remote-debugging-port=7333`)
			}
		} else {
			this.browser = await launch({
				args: [
					"--user-agent=Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
				],
				defaultViewport: {
					width: 900,
					height: 600
				},
				headless: false, // Always use non-headless mode
			})

		}

		this.page = await this.browser?.newPage()

		return {
			screenshot: "",
			logs: this.isInteractive ? 
				"Connected to browser in remote debugging mode." :
				"Browser launched successfully.",
			currentUrl: this.page?.url(),
			currentMousePosition: this.currentMousePosition,
		}
	}

	async closeBrowser(): Promise<BrowserActionResult> {

		if(this.isInteractive) {
			console.log("disconnecting browser...")
			await this.browser?.disconnect().catch(() => {})
		} else {
			console.log("closing browser...")
			await this.browser?.close().catch(() => {})
		}
		return {}
	}

	private async getCurrentScreenshot(): Promise<string | undefined> {
		if (!this.page) return undefined

		let options: ScreenshotOptions = {
			encoding: "base64",
		}

		try {
			let screenshotBase64 = await this.page.screenshot({
				...options,
				type: "webp",
			})
			return `data:image/webp;base64,${screenshotBase64}`
		} catch (err) {
			try {
				let screenshotBase64 = await this.page.screenshot({
					...options,
					type: "png",
				})
				return `data:image/png;base64,${screenshotBase64}`
			} catch (err) {
				console.error("Failed to take screenshot:", err)
				return undefined
			}
		}
	}

	async doAction(action: (page: Page) => Promise<void>): Promise<BrowserActionResult> {
		
		if (!this.page) {
			throw new Error(
				"Browser is not launched or connected. This may occur if the browser was automatically closed by a non-`browser_action` tool.",
			)
		}

		const logs: string[] = []
		let lastLogTs = Date.now()

		const consoleListener = (msg: any) => {
			if (msg.type() === "log") {
				logs.push(msg.text())
			} else {
				logs.push(`[${msg.type()}] ${msg.text()}`)
			}
			lastLogTs = Date.now()
		}

		const errorListener = (err: Error) => {
			logs.push(`[Page Error] ${err.toString()}`)
			lastLogTs = Date.now()
		}

		// Add the listeners
		this.page.on("console", consoleListener)
		this.page.on("pageerror", errorListener)

		try {
			await action(this.page)
		} catch (err) {
			if (!(err instanceof TimeoutError)) {
				logs.push(`[Error] ${err.toString()}`)
			}
		}
	
		// Wait for console inactivity, with a timeout
		await pWaitFor(() => Date.now() - lastLogTs >= 500, {
			timeout: 3_000,
			interval: 100,
		}).catch(() => {})
	
		let screenshot = await this.getCurrentScreenshot()
		if (!screenshot) {
			throw new Error("Failed to take screenshot.")
		}
	
		this.page.off("console", consoleListener)
		this.page.off("pageerror", errorListener)
	
		return {
			screenshot,
			logs: logs.join("\n"),
			currentUrl: this.page.url(),
			currentMousePosition: this.currentMousePosition,
		}
	}

	async navigateToUrl(url: string): Promise<BrowserActionResult> {
		return this.doAction(async (page) => {
			await page.goto(url, { timeout: 7_000, waitUntil: ["domcontentloaded", "networkidle2"] })
			await this.waitTillHTMLStable(page) // in case the page is loading more resources
		})
	}

	private async waitTillHTMLStable(page: Page, timeout = 5_000) {
		const checkDurationMsecs = 500
		const maxChecks = timeout / checkDurationMsecs
		let lastHTMLSize = 0
		let checkCounts = 1
		let countStableSizeIterations = 0
		const minStableSizeIterations = 3

		while (checkCounts++ <= maxChecks) {
			let html = await page.content()
			let currentHTMLSize = html.length

			console.log("last: ", lastHTMLSize, " <> curr: ", currentHTMLSize)

			if (lastHTMLSize !== 0 && currentHTMLSize === lastHTMLSize) {
				countStableSizeIterations++
			} else {
				countStableSizeIterations = 0 //reset the counter
			}

			if (countStableSizeIterations >= minStableSizeIterations) {
				console.log("Page rendered fully...")
				break
			}

			lastHTMLSize = currentHTMLSize
			await delay(checkDurationMsecs)
		}
	}

	async click(coordinate: string): Promise<BrowserActionResult> {
		const [x, y] = coordinate.split(",").map(Number)
		return this.doAction(async (page) => {
			// Set up network request monitoring
			let hasNetworkActivity = false
			const requestListener = () => {
				hasNetworkActivity = true
			}
			page.on("request", requestListener)

			// Perform the click
			await page.mouse.click(x, y)
			this.currentMousePosition = coordinate

			// Small delay to check if click triggered any network activity
			await delay(100)

			if (hasNetworkActivity) {
				// If we detected network activity, wait for navigation/loading
				await page
					.waitForNavigation({
						waitUntil: ["domcontentloaded", "networkidle2"],
						timeout: 7000,
					})
					.catch(() => {})
				await this.waitTillHTMLStable(page)
			}

			// Clean up listener
			page.off("request", requestListener)
		})
	}

	async type(text: string): Promise<BrowserActionResult> {
		return this.doAction(async (page) => {
			await page.keyboard.type(text)
		})
	}

	async scrollDown(): Promise<BrowserActionResult> {
		return this.doAction(async (page) => {
			await page.evaluate(() => {
				window.scrollBy({
					top: 600,
					behavior: "auto",
				})
			})
			await delay(300)
		})
	}

	async scrollUp(): Promise<BrowserActionResult> {
		return this.doAction(async (page) => {
			await page.evaluate(() => {
				window.scrollBy({
					top: -600,
					behavior: "auto",
				})
			})
			await delay(300)
		})
	}

	get isInInteractiveMode(): boolean {
		return this.isInteractive
	}
}
