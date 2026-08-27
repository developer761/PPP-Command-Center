/**
 * The slice of the WebXR Device API this app actually calls.
 *
 * TypeScript's DOM lib does not ship WebXR types, and `@types/webxr` would pull
 * the whole spec surface in for the handful of members one component uses.
 * Declaring only what is called keeps the compiler honest about the shape of
 * those calls without pretending to describe the rest of the API.
 */
interface XRRigidTransform {
  readonly position: DOMPointReadOnly;
  readonly matrix: Float32Array;
  readonly inverse: XRRigidTransform;
}
interface XRView {
  readonly projectionMatrix: Float32Array;
  readonly transform: XRRigidTransform;
}
interface XRViewerPose {
  readonly views: ReadonlyArray<XRView>;
}
interface XRPose {
  readonly transform: XRRigidTransform;
}
interface XRSpace {
  readonly __xrSpaceBrand?: never;
}
interface XRReferenceSpace extends XRSpace {}
interface XRHitTestResult {
  getPose(baseSpace: XRSpace): XRPose | null | undefined;
}
interface XRHitTestSource {
  cancel(): void;
}
interface XRFrame {
  getViewerPose(space: XRReferenceSpace): XRViewerPose | null | undefined;
  getHitTestResults(source: XRHitTestSource): ReadonlyArray<XRHitTestResult>;
}
interface XRWebGLLayerType {
  readonly framebuffer: WebGLFramebuffer | null;
}
interface XRSession extends EventTarget {
  requestReferenceSpace(type: "local" | "viewer" | "local-floor"): Promise<XRReferenceSpace>;
  requestHitTestSource(options: { space: XRSpace }): Promise<XRHitTestSource> | undefined;
  requestAnimationFrame(cb: (time: number, frame: XRFrame) => void): number;
  updateRenderState(state: { baseLayer?: XRWebGLLayerType }): void;
  end(): Promise<void>;
}
interface XRSystem {
  isSessionSupported(mode: string): Promise<boolean>;
  requestSession(
    mode: string,
    init?: {
      requiredFeatures?: string[];
      optionalFeatures?: string[];
      domOverlay?: { root: Element };
    }
  ): Promise<XRSession>;
}
interface Navigator {
  readonly xr?: XRSystem;
}
declare const XRWebGLLayer: {
  new (session: XRSession, gl: WebGLRenderingContext): XRWebGLLayerType;
};
interface WebGLRenderingContext {
  makeXRCompatible(): Promise<void>;
}
