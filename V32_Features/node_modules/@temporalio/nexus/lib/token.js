"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.OperationTokenType = void 0;
exports.generateWorkflowRunOperationToken = generateWorkflowRunOperationToken;
exports.loadOperationToken = loadOperationToken;
exports.loadWorkflowRunOperationToken = loadWorkflowRunOperationToken;
exports.assertWorkflowRunOperationToken = assertWorkflowRunOperationToken;
exports.base64URLEncodeNoPadding = base64URLEncodeNoPadding;
/**
 * @internal
 * @hidden
 */
exports.OperationTokenType = {
    WORKFLOW_RUN: 1,
};
/**
 * Generate a workflow run Operation token.
 */
function generateWorkflowRunOperationToken(namespace, workflowId) {
    const token = {
        t: exports.OperationTokenType.WORKFLOW_RUN,
        ns: namespace,
        wid: workflowId,
    };
    return base64URLEncodeNoPadding(JSON.stringify(token));
}
/**
 * Load and validate the common fields of an Operation token.
 */
function loadOperationToken(data) {
    if (!data) {
        throw new TypeError('invalid operation token: token is empty');
    }
    let decoded;
    try {
        decoded = base64URLDecodeNoPadding(data);
    }
    catch (err) {
        throw new TypeError('failed to decode token', { cause: err });
    }
    let token;
    try {
        token = JSON.parse(decoded);
    }
    catch (err) {
        throw new TypeError('failed to unmarshal Operation token', { cause: err });
    }
    if (typeof token !== 'object' || token == null) {
        throw new TypeError(`invalid operation token: expected object, got ${typeof token}`);
    }
    if (token.v !== undefined && token.v !== 0) {
        throw new TypeError('invalid operation token: "v" field should not be present');
    }
    if (typeof token.t !== 'number') {
        throw new TypeError(`invalid operation token: expected token type to be a number, got ${typeof token.t}`);
    }
    if (!isOperationTokenType(token.t)) {
        throw new TypeError(`invalid operation token: unknown token type: ${token.t}`);
    }
    if (typeof token.ns !== 'string') {
        throw new TypeError(`invalid operation token: expected namespace to be a string, got ${typeof token.ns}`);
    }
    return token;
}
/**
 * Load and validate a workflow run Operation token.
 */
function loadWorkflowRunOperationToken(data) {
    const token = loadOperationToken(data);
    assertWorkflowRunOperationToken(token);
    return token;
}
/**
 * Assert that an OperationToken identifies a workflow run.
 */
function assertWorkflowRunOperationToken(token) {
    if (token.t !== exports.OperationTokenType.WORKFLOW_RUN) {
        throw new TypeError(`invalid workflow token type: ${token.t}, expected: ${exports.OperationTokenType.WORKFLOW_RUN}`);
    }
    if (!token.wid || typeof token.wid !== 'string') {
        throw new TypeError('invalid workflow run token: missing workflow ID (wid)');
    }
}
function isOperationTokenType(value) {
    return Object.values(exports.OperationTokenType).includes(value);
}
// Exported for use in tests.
function base64URLEncodeNoPadding(str) {
    const base64 = Buffer.from(str).toString('base64url');
    return base64.replace(/[=]+$/, '');
}
function base64URLDecodeNoPadding(str) {
    // Validate the string contains only valid base64URL characters
    if (!/^[A-Za-z0-9_-]*$/.test(str)) {
        throw new TypeError('invalid base64URL encoded string: contains invalid characters');
    }
    const paddingLength = str.length % 4;
    if (paddingLength > 0) {
        str += '='.repeat(4 - paddingLength);
    }
    return Buffer.from(str, 'base64url').toString('utf-8');
}
//# sourceMappingURL=token.js.map