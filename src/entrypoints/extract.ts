import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { extractPage, readHttpStatus } from '../lib/extract-page';

// Injected with scripting.executeScript after a user action; the return value is the extraction result.
export default defineUnlistedScript(() => extractPage(document, readHttpStatus()));
