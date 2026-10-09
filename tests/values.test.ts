import { describe, expect, it } from 'vitest';
import { findValues } from '../src/lib/values';

const found = (text: string) => findValues(text).map((f) => [f.kind, f.value, f.raw]);

describe('values in text', () => {
  it('finds email, crypto, IBAN and Telegram values in one form, and leaves out look-alikes whose checksum or shape is wrong', () => {
    const text = [
      'Write to Press@Harbour.Example.org. Donations: bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh, BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4,',
      'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0 or 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy and 0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed.',
      'Account PL61 1090 1014 0000 0712 1981 2874 2000 r., NL91ABNA0417164300. Channel https://t.me/HarbourWatch/123, invite t.me/+AbCdEfGhIjKlMn.',
      // Two IBANs in a row, one with non-breaking spaces; values written next to Chinese and Japanese; a word glued after the final dot.
      'Konta: BE68 5390 0754 7034 FR14\u00a02004\u00a01010\u00a00505\u00a00001\u00a03M02\u00a0606 お問い合わせはinfo@example.co.jpまで 钱包bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4请 john@example.com.Thanks',
      // Look-alikes: an image name, one changed character in each checksum, a bech32m checksum on a version 0 address, the zero address,
      // t.me paths that are not usernames, a word ending in t.me, a Kelvin sign for K, users in addresses, a country without IBANs.
      'icon@2x.png bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlj 3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLz bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kemeawh',
      '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAeD 0x0000000000000000000000000000000000000000 GB82 WEST 1234 5698 7654 33 t.me/share/url foot.me/abcdef',
      't.me/giftcode/kXz9wQ1mPp2 t.me/joinchat t.me/\u212Aabcde git clone git@github.com:user/repo.git https://user:token@example.com/x ZZ88 1078 5678 9012',
    ].join('\n');
    expect(found(text)).toEqual([
      ['email', 'press@harbour.example.org', 'Press@Harbour.Example.org'],
      ['bitcoin', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh', 'bc1qxy2kgdygjrsqtzq2n0yrf2493p83kkfjhx0wlh'],
      ['bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4'],
      ['bitcoin', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0', 'bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0'],
      ['bitcoin', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy', '3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy'],
      ['ethereum', '0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed', '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'],
      // The year after the IBAN is not part of it, even when the longer number would pass the check.
      ['iban', 'PL61 1090 1014 0000 0712 1981 2874', 'PL61 1090 1014 0000 0712 1981 2874'],
      ['iban', 'NL91 ABNA 0417 1643 00', 'NL91ABNA0417164300'],
      ['telegram', 't.me/harbourwatch', 'https://t.me/HarbourWatch'],
      ['telegram', 't.me/+AbCdEfGhIjKlMn', 't.me/+AbCdEfGhIjKlMn'],
      ['iban', 'BE68 5390 0754 7034', 'BE68 5390 0754 7034'],
      ['iban', 'FR14 2004 1010 0505 0001 3M02 606', 'FR14\u00a02004\u00a01010\u00a00505\u00a00001\u00a03M02\u00a0606'],
      ['email', 'info@example.co.jp', 'info@example.co.jp'],
      ['bitcoin', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4', 'bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4'],
      ['email', 'john@example.com', 'john@example.com'],
    ]);
  });
});
