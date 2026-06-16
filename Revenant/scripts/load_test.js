import http from 'k6/http';
import { check } from 'k6';
import { SharedArray } from 'k6/data';
import { Counter, Rate, Trend } from 'k6/metrics';

const TARGET_RPS = parseInt(__ENV.TARGET_RPS || '5000');
const GATEWAY_URL = __ENV.GATEWAY_URL || 'http://localhost:8080';
const PAYMENT_ENDPOINT = `${GATEWAY_URL}/v1/tx/payment`;

const ammo = new SharedArray('revenant_ammo', function () {
    return JSON.parse(open('ammo.json'));
});
const ammoLength = ammo.length;

const powRejections = new Counter('revenant_pow_rejections');
const deadlineRejections = new Counter('revenant_deadline_rejections');
const sigRejections = new Counter('revenant_sig_rejections');
const gatewayLatency = new Trend('revenant_gateway_latency', true);
const successRate = new Rate('revenant_success_rate');

export const options = {
    scenarios: {
        sovereign_load: {
            executor: 'ramping-arrival-rate',
            startRate: Math.floor(TARGET_RPS * 0.1),
            timeUnit: '1s',
            stages: [
                { target: TARGET_RPS, duration: '60s' },
                { target: TARGET_RPS, duration: '120s' },
                { target: 0, duration: '30s' },
            ],
            // Увеличиваем лимиты для стабильных 10k+ TPS
            preAllocatedVUs: Math.ceil(TARGET_RPS / 20),
            maxVUs: Math.ceil(TARGET_RPS / 10),
        },
    },
    thresholds: {
        'http_req_duration{scenario:sovereign_load}': ['p(99)<200', 'p(95)<100'],
        'http_req_failed{scenario:sovereign_load}': ['rate<0.01'],
        'revenant_pow_rejections': ['count<1'],
        'revenant_sig_rejections': ['count<1'],
    },
    // УДАЛЕНО поле http: { timeout: '400ms' }, вызывавшее WARN
};

export default function () {
    const entry = ammo[Math.floor(Math.random() * ammoLength)];
    const deadline = Date.now() + 5000;

    const params = {
        headers: {
            'Content-Type': 'application/json',
            'Connection': 'keep-alive',
            'X-Deadline-Timestamp': String(deadline),
            'X-Public-Key': entry.pub_key,
            'X-Signature': entry.signature,
            'X-Proof-Of-Work': entry.pow_nonce,
        },
        timeout: '400ms', // ТАЙМАУТ ПЕРЕНЕСЕН СЮДА
        responseType: 'text',
        redirects: 0,
    };

    const res = http.post(PAYMENT_ENDPOINT, entry.payload, params);

    gatewayLatency.add(res.timings.duration);
    successRate.add(res.status === 202);

    if (res.status !== 202) {
        const body = res.body || '';
        if (body.includes('POW_INSUFFICIENT')) {
            powRejections.add(1);
        } else if (res.status === 408 || body.includes('DEADLINE_EXCEEDED')) {
            deadlineRejections.add(1);
        } else if (res.status === 401 || body.includes('UNAUTHORIZED')) {
            sigRejections.add(1);
        }
    }

    check(res, {
        'status is 202': (r) => r.status === 202,
        'latency under 200ms': (r) => r.timings.duration < 200,
    });
}
