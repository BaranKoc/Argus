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
exports.getPlatform = getPlatform;
exports.isNativeSupported = isNativeSupported;
exports.loadNativeAddon = loadNativeAddon;
exports.getNativeWindowHandle = getNativeWindowHandle;
const path = __importStar(require("path"));
let cachedAddon;
function getPlatform() {
    return process.platform;
}
function isNativeSupported() {
    return process.platform === 'darwin' || process.platform === 'win32';
}
function loadNativeAddon() {
    if (cachedAddon !== undefined) {
        return cachedAddon;
    }
    if (!isNativeSupported()) {
        cachedAddon = null;
        return null;
    }
    try {
        // Try prebuild first (installed via node-gyp-build)
        const gypBuild = require('node-gyp-build');
        const addon = gypBuild(path.resolve(__dirname, '..'));
        cachedAddon = addon;
        return cachedAddon;
    }
    catch {
        // prebuild not found, try local build directory
    }
    try {
        const addon = require('../build/Release/native_share.node');
        cachedAddon = addon;
        return cachedAddon;
    }
    catch {
        // local build not found either
    }
    cachedAddon = null;
    return null;
}
function getNativeWindowHandle(browserWindow) {
    if (!browserWindow || typeof browserWindow.getNativeWindowHandle !== 'function') {
        return undefined;
    }
    return browserWindow.getNativeWindowHandle();
}
//# sourceMappingURL=platform.js.map