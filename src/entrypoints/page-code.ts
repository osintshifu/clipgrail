import { defineUnlistedScript } from 'wxt/utils/define-unlisted-script';
import { readPageCode } from '../lib/page-code';

// Injected with scripting.executeScript when a selection is clipped; the return value is the page code and the page address.
export default defineUnlistedScript(() => readPageCode(document));
