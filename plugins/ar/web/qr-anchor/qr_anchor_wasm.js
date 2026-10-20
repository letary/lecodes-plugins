/* @ts-self-types="./qr_anchor_wasm.d.ts" */

/**
 * The QR-anchor session as seen from JS.
 */
export class QrAnchor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        QrAnchorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_qranchor_free(ptr, 0);
    }
    /**
     * Drop the pending hints.
     */
    clear_hints() {
        wasm.qranchor_clear_hints(this.__wbg_ptr);
    }
    /**
     * Current frame height, px.
     * @returns {number}
     */
    frame_height() {
        const ret = wasm.qranchor_frame_height(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the `width * height` grey frame buffer in wasm memory, row-major. Reallocated
     * (zeroed) only when the size changes. Null (0) for an invalid size (zero, or beyond the
     * detector's limits), which leaves an empty frame.
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    frame_ptr(width, height) {
        const ret = wasm.qranchor_frame_ptr(this.__wbg_ptr, width, height);
        return ret >>> 0;
    }
    /**
     * Current frame width, px.
     * @returns {number}
     */
    frame_width() {
        const ret = wasm.qranchor_frame_width(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Convert the RGBA staging buffer into the frame buffer ([`rgba_to_gray`]). No-op when the
     * staging buffer does not match the frame size.
     */
    gray_from_rgba() {
        wasm.qranchor_gray_from_rgba(this.__wbg_ptr);
    }
    /**
     * A session from the config JSON (`qr_anchor::json`: an object merged over the defaults,
     * e.g. `{"search_first": true}`; `""` = defaults). Throws on invalid JSON, a wrong type
     * or an unknown key.
     * @param {string} config_json
     */
    constructor(config_json) {
        const ptr0 = passStringToWasm0(config_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qranchor_new(ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        this.__wbg_ptr = ret[0];
        QrAnchorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * Values written by the last process: `count * 28`.
     * @returns {number}
     */
    output_len() {
        const ret = wasm.qranchor_output_len(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Pointer to the `f64` output buffer (`output_len()` values, [`OUTPUT_STRIDE`] per
     * observation). Moves only on [`QrAnchor::set_targets`].
     * @returns {number}
     */
    output_ptr() {
        const ret = wasm.qranchor_output_ptr(this.__wbg_ptr);
        return ret >>> 0;
    }
    /**
     * Find the targets in the frame buffer with intrinsics `fx, fy, cx, cy` (px of this frame,
     * y down, pixel centres at integer coordinates). Writes the output buffer and returns the
     * observation count.
     * @param {number} fx
     * @param {number} fy
     * @param {number} cx
     * @param {number} cy
     * @returns {number}
     */
    process(fx, fy, cx, cy) {
        const ret = wasm.qranchor_process(this.__wbg_ptr, fx, fy, cx, cy);
        return ret >>> 0;
    }
    /**
     * [`QrAnchor::process`] with the intrinsics of a column-major GL / WebXR projection matrix
     * `p` (`XRView.projectionMatrix`) covering the frame: pass `p[0], p[5], p[8], p[9]`
     * (`qr_anchor::Intrinsics::from_gl_projection`).
     * @param {number} p0
     * @param {number} p5
     * @param {number} p8
     * @param {number} p9
     * @returns {number}
     */
    process_gl(p0, p5, p8, p9) {
        const ret = wasm.qranchor_process_gl(this.__wbg_ptr, p0, p5, p8, p9);
        return ret >>> 0;
    }
    /**
     * Forget the per-target history (the re-acquire gate, the tracked windows).
     */
    reset() {
        wasm.qranchor_reset(this.__wbg_ptr);
    }
    /**
     * Pointer to a `width * height * 4` RGBA staging buffer in wasm memory (for
     * [`QrAnchor::gray_from_rgba`]); also sizes the frame buffer. Null (0) for an invalid size.
     * @param {number} width
     * @param {number} height
     * @returns {number}
     */
    rgba_ptr(width, height) {
        const ret = wasm.qranchor_rgba_ptr(this.__wbg_ptr, width, height);
        return ret >>> 0;
    }
    /**
     * A detection window for `target` (frame px, columns `x0..x1`, rows `y0..y1`, ends
     * exclusive; clamped to the frame) for the next [`QrAnchor::process`] only. Ignored for an
     * unknown target.
     * @param {number} target
     * @param {number} x0
     * @param {number} y0
     * @param {number} x1
     * @param {number} y1
     */
    set_hint(target, x0, y0, x1, y1) {
        wasm.qranchor_set_hint(this.__wbg_ptr, target, x0, y0, x1, y1);
    }
    /**
     * Replace the targets: `[{ "text": "<payload>", "size": <metres> }, ...]` (`size` = printed
     * side of the modules without the quiet zone). Observations name a target by its index in
     * this list. Resizes the output buffer (its pointer may move). Throws on invalid JSON.
     * @param {string} targets_json
     * @returns {number}
     */
    set_targets(targets_json) {
        const ptr0 = passStringToWasm0(targets_json, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.qranchor_set_targets(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
}
if (Symbol.dispose) QrAnchor.prototype[Symbol.dispose] = QrAnchor.prototype.free;

/**
 * Version of the output layout ([`qr_anchor::flat::LAYOUT_VERSION`]); JS checks it against
 * its own copy of the layout.
 * @returns {number}
 */
export function output_layout_version() {
    const ret = wasm.output_layout_version();
    return ret >>> 0;
}

/**
 * Values per observation in the output buffer (28).
 * @returns {number}
 */
export function output_stride() {
    const ret = wasm.output_stride();
    return ret >>> 0;
}

/**
 * Runs once when the wasm module is instantiated.
 */
export function start() {
    wasm.start();
}

/**
 * The crate version (`qr-anchor`'s).
 * @returns {string}
 */
export function version() {
    let deferred1_0;
    let deferred1_1;
    try {
        const ret = wasm.version();
        deferred1_0 = ret[0];
        deferred1_1 = ret[1];
        return getStringFromWasm0(ret[0], ret[1]);
    } finally {
        wasm.__wbindgen_free(deferred1_0, deferred1_1, 1);
    }
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg_Error_30c8987f7c2ed4e2: function(arg0, arg1) {
            const ret = Error(getStringFromWasm0(arg0, arg1));
            return ret;
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./qr_anchor_wasm_bg.js": import0,
    };
}

const QrAnchorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_qranchor_free(ptr, 1));

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('qr_anchor_wasm_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
