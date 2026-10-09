import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { extractPage, readHttpStatus } from '../lib/extract-page';
import { readPageCode } from '../lib/page-code';

// Injected with scripting.executeScript after a user action; the return value is the extraction result with the page code.
export default defineUnlistedScript(() => ({ ...extractPage(document, readHttpStatus()), page_code: readPageCode(document) }));
