/**
 * TLS Sidecar 集成测试
 * 验证多 profile 支持、无效 profile 返回 400、向后兼容
 *
 * 运行前提：先编译 sidecar binary
 *   cd tls-sidecar && go build -o tls-sidecar .
 *
 * 运行：npx jest tests/tls-sidecar-integration.test.js --testTimeout=30000
 */
import { spawn } from 'child_process';
import axios from 'axios';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SIDECAR_PORT = 19090; // 使用非默认端口避免冲突
const SIDECAR_URL = `http://127.0.0.1:${SIDECAR_PORT}`;
const SIDECAR_BINARY = path.resolve(__dirname, '..', 'tls-sidecar', 'tls-sidecar');

let sidecarProcess = null;

async function waitForHealth(url, timeoutMs = 10000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        try {
            const resp = await axios.get(`${url}/health`, { timeout: 1000 });
            if (resp.status === 200) return true;
        } catch { /* retry */ }
        await new Promise(r => setTimeout(r, 200));
    }
    throw new Error('Sidecar health check timed out');
}

beforeAll(async () => {
    sidecarProcess = spawn(SIDECAR_BINARY, [], {
        env: { ...process.env, TLS_SIDECAR_PORT: String(SIDECAR_PORT) },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    sidecarProcess.stdout.on('data', (d) => process.stdout.write(`[sidecar] ${d}`));
    sidecarProcess.stderr.on('data', (d) => process.stderr.write(`[sidecar-err] ${d}`));
    await waitForHealth(SIDECAR_URL);
});

afterAll(() => {
    if (sidecarProcess) {
        sidecarProcess.kill('SIGTERM');
        sidecarProcess = null;
    }
});

describe('TLS Sidecar Integration', () => {
    describe('health endpoint', () => {
        it('reports multi-profile support', async () => {
            const resp = await axios.get(`${SIDECAR_URL}/health`);
            expect(resp.status).toBe(200);
            expect(resp.data.tls).toBe('utls-multi-profile');
            expect(resp.data.profiles).toBeDefined();
        });
    });

    describe('profile selection', () => {
        it('accepts valid X-Tls-Profile header', async () => {
            const resp = await axios({
                method: 'GET',
                url: SIDECAR_URL,
                headers: {
                    'X-Target-Url': 'https://httpbin.org/get',
                    'X-Tls-Profile': 'HelloChrome_120',
                },
                timeout: 15000,
            });
            expect(resp.status).toBe(200);
        });

        it('returns 400 for invalid profile', async () => {
            try {
                await axios({
                    method: 'GET',
                    url: SIDECAR_URL,
                    headers: {
                        'X-Target-Url': 'https://httpbin.org/get',
                        'X-Tls-Profile': 'InvalidProfile_999',
                    },
                    timeout: 5000,
                });
                fail('Should have thrown');
            } catch (err) {
                expect(err.response.status).toBe(400);
                expect(err.response.data.error || JSON.stringify(err.response.data)).toContain('invalid X-Tls-Profile');
            }
        });

        it('defaults to Chrome_Auto when no profile header', async () => {
            const resp = await axios({
                method: 'GET',
                url: SIDECAR_URL,
                headers: {
                    'X-Target-Url': 'https://httpbin.org/get',
                },
                timeout: 15000,
            });
            expect(resp.status).toBe(200);
        });
    });

    describe('different profiles produce different TLS fingerprints', () => {
        const TLS_CHECK_URL = 'https://tls.browserleaks.com/json';

        it('Chrome_120 and Chrome_133 both connect successfully', async () => {
            const [resp120, resp133] = await Promise.all([
                axios({
                    method: 'GET',
                    url: SIDECAR_URL,
                    headers: { 'X-Target-Url': TLS_CHECK_URL, 'X-Tls-Profile': 'HelloChrome_120' },
                    timeout: 15000,
                }),
                axios({
                    method: 'GET',
                    url: SIDECAR_URL,
                    headers: { 'X-Target-Url': TLS_CHECK_URL, 'X-Tls-Profile': 'HelloChrome_133' },
                    timeout: 15000,
                }),
            ]);

            expect(resp120.status).toBe(200);
            expect(resp133.status).toBe(200);

            // Log full response for manual JA3/JA4 inspection
            console.log('Chrome_120 TLS info:', JSON.stringify(resp120.data, null, 2).slice(0, 500));
            console.log('Chrome_133 TLS info:', JSON.stringify(resp133.data, null, 2).slice(0, 500));
        });

        it('Chrome and Firefox produce different TLS responses', async () => {
            const [respChrome, respFirefox] = await Promise.all([
                axios({
                    method: 'GET',
                    url: SIDECAR_URL,
                    headers: { 'X-Target-Url': TLS_CHECK_URL, 'X-Tls-Profile': 'HelloChrome_133' },
                    timeout: 15000,
                }),
                axios({
                    method: 'GET',
                    url: SIDECAR_URL,
                    headers: { 'X-Target-Url': TLS_CHECK_URL, 'X-Tls-Profile': 'HelloFirefox_120' },
                    timeout: 15000,
                }),
            ]);

            expect(respChrome.status).toBe(200);
            expect(respFirefox.status).toBe(200);
            // The responses should differ in some TLS-related field
            expect(JSON.stringify(respChrome.data)).not.toEqual(JSON.stringify(respFirefox.data));

            console.log('Chrome_133 TLS:', JSON.stringify(respChrome.data, null, 2).slice(0, 300));
            console.log('Firefox_120 TLS:', JSON.stringify(respFirefox.data, null, 2).slice(0, 300));
        });
    });

    describe('backward compatibility', () => {
        it('missing X-Target-Url returns 400', async () => {
            try {
                await axios({ method: 'GET', url: SIDECAR_URL, timeout: 5000 });
                fail('Should have thrown');
            } catch (err) {
                expect(err.response.status).toBe(400);
                expect(err.response.data.error || err.response.data).toContain('missing X-Target-Url');
            }
        });
    });
});
