/* tslint:disable */
/* eslint-disable */

/**
 * The QR-anchor session as seen from JS.
 */
export class QrAnchor {
    free(): void;
    [Symbol.dispose](): void;
    /**
     * Drop the pending hints.
     */
    clear_hints(): void;
    /**
     * Current frame height, px.
     */
    frame_height(): number;
    /**
     * Pointer to the `width * height` grey frame buffer in wasm memory, row-major. Reallocated
     * (zeroed) only when the size changes. Null (0) for an invalid size (zero, or beyond the
     * detector's limits), which leaves an empty frame.
     */
    frame_ptr(width: number, height: number): number;
    /**
     * Current frame width, px.
     */
    frame_width(): number;
    /**
     * Convert the RGBA staging buffer into the frame buffer ([`rgba_to_gray`]). No-op when the
     * staging buffer does not match the frame size.
     */
    gray_from_rgba(): void;
    /**
     * A session from the config JSON (`qr_anchor::json`: an object merged over the defaults,
     * e.g. `{"search_first": true}`; `""` = defaults). Throws on invalid JSON, a wrong type
     * or an unknown key.
     */
    constructor(config_json: string);
    /**
     * Values written by the last process: `count * 28`.
     */
    output_len(): number;
    /**
     * Pointer to the `f64` output buffer (`output_len()` values, [`OUTPUT_STRIDE`] per
     * observation). Moves only on [`QrAnchor::set_targets`].
     */
    output_ptr(): number;
    /**
     * Find the targets in the frame buffer with intrinsics `fx, fy, cx, cy` (px of this frame,
     * y down, pixel centres at integer coordinates). Writes the output buffer and returns the
     * observation count.
     */
    process(fx: number, fy: number, cx: number, cy: number): number;
    /**
     * [`QrAnchor::process`] with the intrinsics of a column-major GL / WebXR projection matrix
     * `p` (`XRView.projectionMatrix`) covering the frame: pass `p[0], p[5], p[8], p[9]`
     * (`qr_anchor::Intrinsics::from_gl_projection`).
     */
    process_gl(p0: number, p5: number, p8: number, p9: number): number;
    /**
     * Forget the per-target history (the re-acquire gate, the tracked windows).
     */
    reset(): void;
    /**
     * Pointer to a `width * height * 4` RGBA staging buffer in wasm memory (for
     * [`QrAnchor::gray_from_rgba`]); also sizes the frame buffer. Null (0) for an invalid size.
     */
    rgba_ptr(width: number, height: number): number;
    /**
     * A detection window for `target` (frame px, columns `x0..x1`, rows `y0..y1`, ends
     * exclusive; clamped to the frame) for the next [`QrAnchor::process`] only. Ignored for an
     * unknown target.
     */
    set_hint(target: number, x0: number, y0: number, x1: number, y1: number): void;
    /**
     * Replace the targets: `[{ "text": "<payload>", "size": <metres> }, ...]` (`size` = printed
     * side of the modules without the quiet zone). Observations name a target by its index in
     * this list. Resizes the output buffer (its pointer may move). Throws on invalid JSON.
     */
    set_targets(targets_json: string): number;
}

/**
 * Version of the output layout ([`qr_anchor::flat::LAYOUT_VERSION`]); JS checks it against
 * its own copy of the layout.
 */
export function output_layout_version(): number;

/**
 * Values per observation in the output buffer (28).
 */
export function output_stride(): number;

/**
 * Runs once when the wasm module is instantiated.
 */
export function start(): void;

/**
 * The crate version (`qr-anchor`'s).
 */
export function version(): string;

export type InitInput = RequestInfo | URL | Response | BufferSource | WebAssembly.Module;

export interface InitOutput {
    readonly memory: WebAssembly.Memory;
    readonly __wbg_qranchor_free: (a: number, b: number) => void;
    readonly output_layout_version: () => number;
    readonly output_stride: () => number;
    readonly qranchor_clear_hints: (a: number) => void;
    readonly qranchor_frame_height: (a: number) => number;
    readonly qranchor_frame_ptr: (a: number, b: number, c: number) => number;
    readonly qranchor_frame_width: (a: number) => number;
    readonly qranchor_gray_from_rgba: (a: number) => void;
    readonly qranchor_new: (a: number, b: number) => [number, number, number];
    readonly qranchor_output_len: (a: number) => number;
    readonly qranchor_output_ptr: (a: number) => number;
    readonly qranchor_process: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly qranchor_process_gl: (a: number, b: number, c: number, d: number, e: number) => number;
    readonly qranchor_reset: (a: number) => void;
    readonly qranchor_rgba_ptr: (a: number, b: number, c: number) => number;
    readonly qranchor_set_hint: (a: number, b: number, c: number, d: number, e: number, f: number) => void;
    readonly qranchor_set_targets: (a: number, b: number, c: number) => [number, number, number];
    readonly start: () => void;
    readonly version: () => [number, number];
    readonly __wbindgen_free: (a: number, b: number, c: number) => void;
    readonly __wbindgen_malloc: (a: number, b: number) => number;
    readonly __wbindgen_realloc: (a: number, b: number, c: number, d: number) => number;
    readonly __wbindgen_externrefs: WebAssembly.Table;
    readonly __externref_table_dealloc: (a: number) => void;
    readonly __wbindgen_start: () => void;
}

export type SyncInitInput = BufferSource | WebAssembly.Module;

/**
 * Instantiates the given `module`, which can either be bytes or
 * a precompiled `WebAssembly.Module`.
 *
 * @param {{ module: SyncInitInput }} module - Passing `SyncInitInput` directly is deprecated.
 *
 * @returns {InitOutput}
 */
export function initSync(module: { module: SyncInitInput } | SyncInitInput): InitOutput;

/**
 * If `module_or_path` is {RequestInfo} or {URL}, makes a request and
 * for everything else, calls `WebAssembly.instantiate` directly.
 *
 * @param {{ module_or_path: InitInput | Promise<InitInput> }} module_or_path - Passing `InitInput` directly is deprecated.
 *
 * @returns {Promise<InitOutput>}
 */
export default function __wbg_init (module_or_path?: { module_or_path: InitInput | Promise<InitInput> } | InitInput | Promise<InitInput>): Promise<InitOutput>;
