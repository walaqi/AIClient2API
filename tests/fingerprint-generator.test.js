import { generateFingerprint, hasFingerprint, FINGERPRINT_FIELDS } from '../src/utils/fingerprint-generator.js';

describe('fingerprint-generator', () => {
    const testUUID = 'a1b2c3d4-e5f6-7890-abcd-ef1234567890';
    const testUUID2 = 'f9e8d7c6-b5a4-3210-fedc-ba0987654321';

    describe('determinism', () => {
        it('same UUID produces identical fingerprint across calls', () => {
            const fp1 = generateFingerprint(testUUID, 'grok-web');
            const fp2 = generateFingerprint(testUUID, 'grok-web');
            expect(fp1).toEqual(fp2);
        });

        it('same UUID + same generation is stable', () => {
            const fp1 = generateFingerprint(testUUID, 'grok-web', 0);
            const fp2 = generateFingerprint(testUUID, 'grok-web', 0);
            expect(fp1).toEqual(fp2);
        });

        it('different generation produces different fingerprint', () => {
            const fp0 = generateFingerprint(testUUID, 'grok-web', 0);
            const fp1 = generateFingerprint(testUUID, 'grok-web', 1);
            expect(fp0.ACCOUNT_TLS_PROFILE).not.toEqual(fp1.ACCOUNT_TLS_PROFILE);
        });
    });

    describe('uniqueness', () => {
        it('different UUIDs tend to produce different fingerprints (statistical)', () => {
            // With only 3 Chrome profiles × 3 platforms = 9 combos,
            // individual pairs may collide. Test that across many UUIDs we get diversity.
            const seen = new Set();
            for (let i = 0; i < 30; i++) {
                const fp = generateFingerprint(`unique-test-${i}`, 'grok-web');
                seen.add(fp.ACCOUNT_TLS_PROFILE + '|' + fp.ACCOUNT_PLATFORM + '|' + fp.ACCOUNT_PLATFORM_VERSION);
            }
            // Should see at least 3 distinct combinations out of 30 samples
            expect(seen.size).toBeGreaterThanOrEqual(3);
        });
    });

    describe('version consistency', () => {
        it('TLS profile version matches UA version matches sec-ch-ua version (Chrome)', () => {
            const fp = generateFingerprint(testUUID, 'grok-web');
            const tlsVersion = fp.ACCOUNT_TLS_PROFILE.match(/\d+/)?.[0];
            expect(fp.ACCOUNT_BROWSER_VERSION).toBe(tlsVersion);
            expect(fp.ACCOUNT_USER_AGENT).toContain(`Chrome/${fp.ACCOUNT_SEC_CH_UA_FULL_VERSION}`);
            expect(fp.ACCOUNT_SEC_CH_UA).toContain(`v="${tlsVersion}"`);
        });

        it('platform and platformVersion are consistent with UA', () => {
            const fp = generateFingerprint(testUUID, 'grok-web');
            if (fp.ACCOUNT_PLATFORM === 'Windows') {
                expect(fp.ACCOUNT_USER_AGENT).toContain('Windows NT');
            } else if (fp.ACCOUNT_PLATFORM === 'macOS') {
                expect(fp.ACCOUNT_USER_AGENT).toContain('Macintosh');
            }
        });
    });

    describe('provider constraints', () => {
        it('grok-web only gets Chrome profiles', () => {
            // Test with many UUIDs to ensure all are Chrome
            for (let i = 0; i < 50; i++) {
                const uuid = `test-uuid-${i}-${Date.now()}`;
                const fp = generateFingerprint(uuid, 'grok-web');
                expect(fp.ACCOUNT_TLS_PROFILE).toMatch(/^HelloChrome_/);
                expect(fp.ACCOUNT_SEC_CH_UA).toContain('Google Chrome');
            }
        });

        it('grok provider also gets Chrome profiles', () => {
            const fp = generateFingerprint(testUUID, 'grok');
            expect(fp.ACCOUNT_TLS_PROFILE).toMatch(/^HelloChrome_/);
        });

        it('non-grok providers can get any profile', () => {
            const profiles = new Set();
            for (let i = 0; i < 100; i++) {
                const uuid = `diverse-uuid-${i}`;
                const fp = generateFingerprint(uuid, 'claude');
                profiles.add(fp.ACCOUNT_TLS_PROFILE);
            }
            // Should have more than just Chrome profiles
            expect(profiles.size).toBeGreaterThan(1);
        });
    });

    describe('field completeness', () => {
        it('all fingerprint fields are present', () => {
            const fp = generateFingerprint(testUUID, 'grok-web');
            for (const field of FINGERPRINT_FIELDS) {
                expect(fp).toHaveProperty(field);
            }
        });

        it('ACCOUNT_FINGERPRINT_GENERATION is set', () => {
            const fp = generateFingerprint(testUUID, 'grok-web', 3);
            expect(fp.ACCOUNT_FINGERPRINT_GENERATION).toBe(3);
        });
    });

    describe('hasFingerprint', () => {
        it('returns true when ACCOUNT_TLS_PROFILE is set', () => {
            expect(hasFingerprint({ ACCOUNT_TLS_PROFILE: 'HelloChrome_131' })).toBe(true);
        });

        it('returns false when ACCOUNT_TLS_PROFILE is empty', () => {
            expect(hasFingerprint({ ACCOUNT_TLS_PROFILE: '' })).toBe(false);
        });

        it('returns false for null/undefined config', () => {
            expect(hasFingerprint(null)).toBe(false);
            expect(hasFingerprint(undefined)).toBe(false);
        });
    });
});
