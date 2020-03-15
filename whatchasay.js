const CDP = require('chrome-remote-interface')
const fs = require('fs')
const Path = require('path')
const HttpStatus = require('http-status-codes')
const Crypto = require('crypto')


const outDir = process.argv[2]
const host = process.argv[3]
const port = process.argv[4]

async function main() {
    let client;
    client = await CDP({host, port})

    const { Network } = client

    function checksum(data) {
        return Crypto
            .createHash('md5')
            .update(data)
            .digest()
    }

    function shortenNameIfNeeded(name) {
        const maxLen = 255 -4
        if (name.length < maxLen) return name
        const template = '-TLDR-'
        const ext = Path.extname(name)
        const suffix = template + checksum(Buffer.from(name)).toString('base64') + ext
        prefix = name.slice(0, maxLen - suffix.length)
        return prefix + suffix
    }

    function urlToPath(url) {
        url = new URL(url)
        var pathname = url.pathname
        if (pathname === '/') {
            pathname = "/index.html"
        }

        return Path.join(outDir, url.hostname, ...pathname.split('/').map(shortenNameIfNeeded))
    }

    function saveChecksum(url, body) {
        const path = urlToPath(url) + ".md5"
        return new Promise((resolve, reject) => {
            const data = checksum(body)
            fs.writeFile(path, data, (err) => {
                if (err) reject(err)
                else resolve()
            })
        })
    }

    function checksumFile(path) {
        return new Promise((resolve, reject) => {
            fs.readFile(path, (err, data) => {
                if (err) reject(err)
                else resolve(checksum(data))
            })
        })
    }

    async function checkFileExists(path) {
        return new Promise((resolve, _) => {
            fs.access(path, (err) => {
                if (err) resolve(false)
                else resolve(true)
            })
        })
    }

    async function createDirsIfNeeded(path) {
        return new Promise((resolve, reject) => {
            fs.access(path, (err) => {
                if (err) {
                    fs.mkdir(path, { recursive: true }, (err) => {
                        if (err) {
                            reject(err)
                            return;
                        }
                        resolve()
                    })
                } else {
                    resolve()
                }
            })
        })
    }

    /**
     * 
     * @param {string} url 
     * @param {string} textEncoding 
     * @returns {Promise<Buffer>}
     */
    async function getCollectedResponse(url, textEncoding) {
        return new Promise((resolve, reject) => {
            fs.readFile(urlToPath(url),
                {
                    encoding: null,
                    flag: 'r'
                },
                (err, data) => {
                    if (err) reject(err)
                    else resolve(data)
                })
        })
    }

    async function saveResponseData(url, data, base64Encoded, textEncoding) {
        const path = urlToPath(url)
        await createDirsIfNeeded(Path.dirname(path))
        return new Promise((resolve, reject) => {
            if (base64Encoded) {
                data = Buffer.from(data, 'base64')
            } else {
                data = Buffer.from(data, textEncoding || 'utf-8')
            }
            fs.writeFile(path, data, (err) => {
                if (err) reject(err)
                else {
                    saveChecksum(url, data)
                        .then(resolve)
                        .catch(e => {
                            reject(e)
                        })
                }
            })
        })
    }

    function prepareRawResponse(responseHeaders, body) {
        ignoredHeaders = new Set(['status', 'content-encoding', 'content-length'])
        var header = ''
        const status = responseHeaders['status']
        header += status + ' ' + HttpStatus.getStatusText(parseInt(status)) + '\n'
        for (item in responseHeaders) {
            if (ignoredHeaders.has(item))
                continue
            header += item + ': ' + responseHeaders[item] + '\n'
        }

        const contentLength = body.length
        header += 'Content-length: ' + contentLength + '\n'
        header += '\n'

        header = Buffer.from(header, 'ascii')
        response = Buffer.concat([header, body])
        return response.toString('base64')
    }

    function getSavedChecksum(url) {
        const path = urlToPath(url) + ".md5"
        return new Promise((resolve, reject) => {
            fs.readFile(path, (err, data) => {
                if (err) reject(err)
                else resolve(data)
            })
        })
    }

    async function hasLocalCopy(url) {
        return await checkFileExists(urlToPath(url))
    }

    async function shouldOverrideLocalCopy(url) {
        const edited = await checksumFile(urlToPath(url))
        const saved = await getSavedChecksum(url)
        return edited.equals(saved)
    }

    async function shouldReplaceWithLocalCopy(url, body) {
        const saved = await getSavedChecksum(url)
        const received = checksum(body)
        return saved.equals(received)
    }

    Network.requestIntercepted(async (params) => {
        if (params.responseErrorReason || !params.responseStatusCode
            || params.responseStatusCode == 301) {
            await Network.continueInterceptedRequest({ interceptionId: params.interceptionId })
            return
        }

        const url = params.request.url
        try {
            var { body, base64Encoded } = await Network.getResponseBodyForInterception(
                                                    { interceptionId: params.interceptionId })
        } catch (err) {
            console.error(err)
            await Network.continueInterceptedRequest({ interceptionId: params.interceptionId })
        }
        const contentType = params.responseHeaders['content-type']
        let textEncoding;
        if (contentType && contentType.startsWith('text')) {
            const [_, option] = contentType.split(';')
            if (option && option.trim().startsWith('charset')) {
                let [_, charset] = option.split('=')
                textEncoding = charset.toLowerCase()
            }
        }

        if (base64Encoded) {
            body = Buffer.from(body, "base64")
        } else if (textEncoding) {
            body = Buffer.from(body, textEncoding)
        } else {
            console.error("Non-base64 response body with no encoding specified is not supported")
        }

        if (params.responseHeaders['status'] === undefined) {
            params.responseHeaders['status'] = params.responseStatusCode.toString()
        }

        if (!(await hasLocalCopy(url))) {
            console.log("Create local copy " + params.request.url)
            try {
                await saveResponseData(params.request.url, body, base64Encoded, textEncoding)
            } catch (err) {
                console.error("Failed to save server response, " + err.message)
            }
        } else if (await shouldReplaceWithLocalCopy(url, body)) {
            try {
                console.log(`Replacing ${url} with local copy`)
                body = await getCollectedResponse(params.request.url, textEncoding)
                base64Encoded = false
            } catch (e) {
                console.log("Failed to read saved response: " + e)
            }
        } else if (await shouldOverrideLocalCopy(url)) {
            console.log("Override local copy " + url)
        } else {
            console.warn(`Response for ${url} is different that original, ignoring local edits`)
        }

        var rawResponse = prepareRawResponse(params.responseHeaders, body)
        await Network.continueInterceptedRequest({
            interceptionId: params.interceptionId,
            rawResponse: rawResponse
        })
    })

    await Network.enable()
    await Network.setCacheDisabled({ cacheDisabled: true })
    await Network.setRequestInterception({ patterns: [{ urlPattern: "*", 
                                                        interceptionStage: "HeadersReceived" }] })
}

main();