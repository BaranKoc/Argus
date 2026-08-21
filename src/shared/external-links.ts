// The pages the app may open in the user's browser, addressed by id rather than by URL:
// the renderer asks for 'nvidia-driver' and never hands the main process an address.
// A channel that took a URL would let anything reaching window.api ask the OS to open
// an arbitrary link; a fixed list cannot.
//
// The NVIDIA entry is the DRIVER download, deliberately not the CUDA Toolkit: the GPU
// add-on carries its own CUDA runtime inside the PyTorch cu126 wheel (see
// resources/pyannote/requirements-cuda.txt), so the only thing the machine still has to
// supply is a driver new enough for CUDA 12.x. Sending a user to the multi-GB toolkit
// would cost them an afternoon and fix nothing.
export const EXTERNAL_LINKS = {
  'nvidia-driver': 'https://www.nvidia.com/download/index.aspx',
} as const;

export type ExternalLinkId = keyof typeof EXTERNAL_LINKS;

export function resolveExternalLink(id: unknown): string {
  if (typeof id === 'string' && Object.hasOwn(EXTERNAL_LINKS, id)) {
    return EXTERNAL_LINKS[id as ExternalLinkId];
  }
  throw new Error('Bilinmeyen bağlantı.');
}
