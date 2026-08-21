import type { ShareOptions, ShareResult } from './types';
export type { ShareOptions, ShareResult } from './types';
export declare function canShare(): boolean;
export declare function share(options: ShareOptions, browserWindow?: any): Promise<ShareResult>;
export { getNativeWindowHandle } from './platform';
//# sourceMappingURL=index.d.ts.map