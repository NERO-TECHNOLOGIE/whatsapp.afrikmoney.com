import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import BaseHandler from '../../src/core/BaseHandler.js';
import { uniquePhone } from './_helpers.js';

const handler = new BaseHandler();

describe('BaseHandler — _calculateFees', () => {
    test('applies the flat 2% platform fee when the merchant has none', () => {
        const fees = handler._calculateFees(1000, 0);
        assert.equal(fees.net, 1000);
        assert.equal(fees.fees, 20);
        assert.equal(fees.total, 1020);
    });

    test('adds the merchant service fee percentage on top of the 2% platform fee', () => {
        const fees = handler._calculateFees(1000, 3);
        // (3 + 2)% of 1000 = 50
        assert.equal(fees.fees, 50);
        assert.equal(fees.total, 1050);
    });

    test('rounds fractional fees to the nearest FCFA', () => {
        const fees = handler._calculateFees(333, 0);
        // 333 * 2% = 6.66 -> rounds to 7
        assert.equal(fees.fees, 7);
        assert.equal(fees.total, 340);
    });

    test('treats a missing/invalid service fee as 0', () => {
        const fees = handler._calculateFees(500, undefined);
        assert.equal(fees.fees, 10); // 2% only
    });
});

describe('BaseHandler — _mapOperator', () => {
    test('recognizes MTN aliases (case-insensitive)', () => {
        for (const alias of ['1', 'mtn', 'MTN', 'm', 'M']) {
            assert.equal(handler._mapOperator(alias), 'MTN', `alias "${alias}" should map to MTN`);
        }
    });

    test('recognizes Moov/Flooz aliases', () => {
        for (const alias of ['2', 'moov', 'flooz', 'f', 'mo']) {
            assert.equal(handler._mapOperator(alias), 'Moov');
        }
    });

    test('recognizes Celtiis aliases', () => {
        for (const alias of ['3', 'celtiis', 'c']) {
            assert.equal(handler._mapOperator(alias), 'Celtiis');
        }
    });

    test('returns null for unknown or empty input', () => {
        assert.equal(handler._mapOperator('orange'), null);
        assert.equal(handler._mapOperator(''), null);
        assert.equal(handler._mapOperator(null), null);
        assert.equal(handler._mapOperator(undefined), null);
    });
});

describe('BaseHandler — normalizeId', () => {
    test('strips the JID domain and device suffix', () => {
        assert.equal(handler.normalizeId('22990123456:5@s.whatsapp.net'), '22990123456');
        assert.equal(handler.normalizeId('22990123456@s.whatsapp.net'), '22990123456');
    });

    test('returns an empty string for non-string / falsy input', () => {
        assert.equal(handler.normalizeId(null), '');
        assert.equal(handler.normalizeId(undefined), '');
        assert.equal(handler.normalizeId(42), '');
    });
});

describe('BaseHandler — _normalizePhone', () => {
    test('leaves an already-canonical 229 + 8-digit number untouched', () => {
        assert.equal(handler._normalizePhone('22990123456'), '22990123456');
    });

    test('leaves a 229 + 10-digit (new format) number untouched', () => {
        assert.equal(handler._normalizePhone('2299012345678'), '2299012345678');
    });

    test('prefixes an 8-digit local number with 229', () => {
        assert.equal(handler._normalizePhone('90123456'), '22990123456');
    });

    test('prefixes a 10-digit local number with 229', () => {
        assert.equal(handler._normalizePhone('9012345678'), '2299012345678');
    });

    test('drops a leading 0 from a 9-digit local number before prefixing', () => {
        assert.equal(handler._normalizePhone('090123456'), '22990123456');
    });

    test('strips non-digit characters before normalizing', () => {
        assert.equal(handler._normalizePhone('229 90 12 34 56'), '22990123456');
    });

    test('passes through falsy input unchanged', () => {
        assert.equal(handler._normalizePhone(null), null);
        assert.equal(handler._normalizePhone(''), '');
    });
});

describe('BaseHandler — anti-spam human delay', () => {
    test('does not delay the first message to a fresh jid', async () => {
        const jid = uniquePhone() + '@s.whatsapp.net';
        const start = Date.now();
        await handler._humanDelay(jid);
        assert.ok(Date.now() - start < 100);
    });

    test('delays a second message sent to the same jid within the anti-spam window', async () => {
        const jid = uniquePhone() + '@s.whatsapp.net';

        // First call establishes _lastSentAt for this jid (gap from 0 is huge, no wait).
        await handler._humanDelay(jid);

        // Called again immediately after — gap is ~0ms, so this must wait
        // roughly the 400-800ms anti-spam minimum before resolving.
        const start = Date.now();
        await handler._humanDelay(jid);
        assert.ok(Date.now() - start >= 380, 'should wait roughly the anti-spam minimum gap');
    });
});
