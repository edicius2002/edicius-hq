import { handlePreview } from './previewAdapters.js';
export const GET = (request: Request): Promise<Response> => handlePreview(request, 'file');
