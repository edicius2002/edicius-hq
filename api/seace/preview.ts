import { handlePreview } from './previewAdapters.js';
export const POST = (request: Request): Promise<Response> => handlePreview(request, 'request');
export const GET = (request: Request): Promise<Response> => handlePreview(request, 'status');
