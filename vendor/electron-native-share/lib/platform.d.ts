import type { NativeAddon } from './types';
export declare function getPlatform(): NodeJS.Platform;
export declare function isNativeSupported(): boolean;
export declare function loadNativeAddon(): NativeAddon | null;
export declare function getNativeWindowHandle(browserWindow: any): Buffer | undefined;
//# sourceMappingURL=platform.d.ts.map