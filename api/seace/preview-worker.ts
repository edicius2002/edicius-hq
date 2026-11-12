import { handlePreview } from './previewAdapters.js';
export const GET = (request: Request): Promise<Response> => handlePreview(request, 'work');
export const POST = (request: Request): Promise<Response> => handlePreview(request, 'workerPost');
