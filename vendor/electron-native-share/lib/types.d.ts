export interface ShareOptions {
    title?: string;
    text?: string;
    url?: string;
    /** Array of absolute file paths to share */
    files?: string[];
}
export interface ShareResult {
    method: 'native' | 'cancelled';
}
export interface NativeAddon {
    share(options: NativeShareInput): Promise<void>;
    canShare(): boolean;
}
export interface NativeShareInput {
    title?: string;
    text?: string;
    url?: string;
    files?: string[];
    /** Native window handle (pointer as Buffer) for macOS and Windows */
    windowHandle?: Buffer;
}
//# sourceMappingURL=types.d.ts.map