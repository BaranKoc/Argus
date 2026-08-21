"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.getNativeWindowHandle = void 0;
exports.canShare = canShare;
exports.share = share;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const platform_1 = require("./platform");
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);
// Must match the error message thrown by the native addons (share.mm / share.cpp)
const NATIVE_CANCEL_MESSAGE = 'Share cancelled by user';
function canShare() {
    if (!(0, platform_1.isNativeSupported)())
        return false;
    const addon = (0, platform_1.loadNativeAddon)();
    return addon !== null && addon.canShare();
}
function validateOptions(options) {
    if (!options.text && !options.url && !options.title && (!options.files || options.files.length === 0)) {
        throw new Error('At least one of text, url, title, or files must be provided');
    }
    if (options.url) {
        let parsed;
        try {
            parsed = new URL(options.url);
        }
        catch {
            throw new Error(`Invalid URL: ${options.url}`);
        }
        if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) {
            throw new Error(`Unsupported URL protocol: ${parsed.protocol} (only http and https are allowed)`);
        }
    }
    if (options.files) {
        for (const filePath of options.files) {
            if (!path.isAbsolute(filePath)) {
                throw new Error(`File paths must be absolute: ${filePath}`);
            }
            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }
        }
    }
}
async function share(options, browserWindow) {
    validateOptions(options);
    const addon = (0, platform_1.loadNativeAddon)();
    if (!addon || !addon.canShare()) {
        throw new Error('Native sharing is not available on this platform');
    }
    const input = {
        title: options.title,
        text: options.text,
        url: options.url,
        files: options.files,
    };
    if (browserWindow) {
        input.windowHandle = (0, platform_1.getNativeWindowHandle)(browserWindow);
    }
    try {
        await addon.share(input);
        return { method: 'native' };
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (message === NATIVE_CANCEL_MESSAGE) {
            return { method: 'cancelled' };
        }
        throw error;
    }
}
var platform_2 = require("./platform");
Object.defineProperty(exports, "getNativeWindowHandle", { enumerable: true, get: function () { return platform_2.getNativeWindowHandle; } });
//# sourceMappingURL=index.js.map