import * as THREE from "three";
import * as visual from "../../../editor/VisualModel";
import { Viewport } from "../Viewport";

/**
 * The GPUPicker identifies objects in 3d space pointed at by the mouse. It extracts a 32-bit
 * object id from the rendered rgba color of a picking scene. Depth is extracted from the
 * z-buffer and converted to a world space position.
 * 
 * This picker is unusual in that rather than render a 1x1 pixel scene on every mouse move,
 * we render the entire width,height scene only when the camera stops moving; then on every mouse
 * move we simple read 1 pixel from the width,height buffer. Since the scene is geometry-heavy,
 * this puts less pressure on the vertex shader and more on fragment/memory bandwidth, which
 * is (currently) a good tradeoff.
 * 
 * NOTE: Rather than using this class directly, write or use a GPUPickingAdapter, which returns
 * real objects rather than object ids and is closer to the THREE.js Raycaster interface.
 */

const depthPlane = new THREE.PlaneGeometry(2, 2);

export class GPUPicker {
    static minimumEntityId = 1;

    private readonly scene = new THREE.Scene();
    private objects: THREE.Object3D[] = [];
    readonly pickingTarget = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
    pickingBuffer: Readonly<Uint8Array> = new Uint8Array();

    readonly depthTarget = new THREE.WebGLRenderTarget(1, 1);
    private readonly depthScene = new THREE.Scene();
    private readonly depthCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    depthBuffer: Readonly<Uint8Array> = new Uint8Array();
    depthMaterial = new THREE.ShaderMaterial({
        vertexShader: `
        varying vec2 vUv;
        void main() {
            vUv = uv;
            gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
        `,
        fragmentShader: `
        #include <packing>

        varying vec2 vUv;
        uniform sampler2D tDepth;
        uniform float cameraNear;
        uniform float cameraFar;

        void main() {
            float depth;
            float fragCoordZ = texture2D( tDepth, vUv ).x;
            depth = fragCoordZ;
            gl_FragColor = packDepthToRGBA(depth); // for higher precision, spread float onto 4 bytes
        }
        `,
        uniforms: {
            cameraNear: { value: null },
            cameraFar: { value: null },
            isOrthographic: { value: null },
            tDepth: { value: null }
        }
    });
    private readonly depthQuad = new THREE.Mesh(depthPlane, this.depthMaterial);

    // FIXME verify working
    layers = new THREE.Layers();

    readonly raycasterParams: THREE.RaycasterParameters & { Line2: { threshold: number } } = {
        Line: { threshold: 0.1 },
        Line2: { threshold: 20 },
        Points: { threshold: 1 }
    };

    constructor(private readonly viewport: Viewport) {
        this.render = this.render.bind(this);
        this.depthScene.add(this.depthQuad);
    }

    setSize(offsetWidth: number, offsetHeight: number) {
        this.pickingTarget.setSize(offsetWidth, offsetHeight);
        this.pickingBuffer = new Uint8Array(offsetWidth * offsetHeight * 4);

        this.depthTarget.setSize(offsetWidth, offsetHeight);
        // this.depthTarget.stencilBuffer = false;
        this.depthBuffer = new Uint8Array(offsetWidth * offsetHeight * 4);
        const depthTexture = new THREE.DepthTexture(offsetWidth, offsetHeight);

        this.pickingTarget.depthTexture = depthTexture;
        this.render();
    }

    update(scene: THREE.Object3D[]) {
        this.objects = scene;
        this.render();
    }

    render() {
        const { viewport: { renderer, camera }, objects, scene, pickingTarget, pickingBuffer, depthMaterial, depthCamera, depthScene, depthTarget, depthBuffer } = this;

        console.time("picking");
        renderer.setRenderTarget(pickingTarget);
        for (const object of objects) scene.add(object);
        renderer.render(scene, camera);
        console.timeEnd("picking");

        console.time("depth");
        depthMaterial.uniforms.cameraNear.value = this.viewport.camera.near;
        depthMaterial.uniforms.cameraFar.value = this.viewport.camera.far;
        depthMaterial.uniforms.isOrthographic.value = this.viewport.camera.isOrthographicCamera;
        depthMaterial.uniforms.tDepth.value = pickingTarget.depthTexture;
        renderer.setRenderTarget(depthTarget);
        renderer.render(depthScene, depthCamera);
        console.timeEnd("depth");

        console.time("read");
        renderer.readRenderTargetPixels(pickingTarget, 0, 0, camera.offsetWidth, camera.offsetHeight, pickingBuffer);
        renderer.readRenderTargetPixels(depthTarget, 0, 0, camera.offsetWidth, camera.offsetHeight, depthBuffer);
        console.timeEnd("read");
    }

    show() {
        const { viewport: { renderer, camera }, objects, scene } = this;
        renderer.setRenderTarget(null);
        for (const object of objects) scene.add(object);
        renderer.render(scene, camera);
    }

    private readonly screenPoint = new THREE.Vector2();
    private readonly ndc = new THREE.Vector2();
    setFromCamera(screenPoint: THREE.Vector2, camera: THREE.Camera) {
        this.screenPoint.copy(screenPoint);
        this.viewport.normalizeMousePosition(this.ndc.copy(screenPoint));
    }

    private readonly positionh = new THREE.Vector4();
    private readonly unpackDepth = new THREE.Vector4()
    intersect(): { id: number, position: THREE.Vector3 } | undefined {
        const { screenPoint, ndc, viewport: { camera }, positionh, unpackDepth } = this;
        let i = (screenPoint.x | 0) + ((screenPoint.y | 0) * camera.offsetWidth);

        const buffer = new Uint32Array(this.pickingBuffer.buffer);
        const id = buffer[i];
        if (id === 0 || id === undefined) return undefined;

        // depth from shader a float [0,1] packed over 4 bytes, each [0,255].
        unpackDepth.fromArray(this.depthBuffer.slice(i * 4, i * 4 + 4));
        unpackDepth.divideScalar(255);
        const ndc_z = unpackDepth.dot(UnpackFactors) * 2 - 1;

        // unproject in homogeneous coordinates, cf https://stackoverflow.com/questions/11277501/how-to-recover-view-space-position-given-view-space-depth-value-and-ndc-xy/46118945#46118945
        camera.updateProjectionMatrix(); // ensure up-to-date
        positionh.set(ndc.x, ndc.y, ndc_z, 1);
        positionh.applyMatrix4(camera.projectionMatrixInverse).applyMatrix4(camera.matrixWorld);

        // for perspective, unhomogenize
        const position = new THREE.Vector3(positionh.x, positionh.height, positionh.z).divideScalar(positionh.w);
        console.log(position);
        
        return { id, position };
    }

    // FIXME move into GPUDatabaseAdapter
    static compactTopologyId(type: 'edge' | 'face', parentId: number, index: number): number {
        if (parentId > (1 << 16)) throw new Error("precondition failure");
        if (index > (1 << 15)) throw new Error("precondition failure");

        parentId <<= 16;
        const c = (type === 'edge' ? 0 : 1) << 7;
        const d = c | ((index >> 8) & 0xef);
        const e = ((index >> 0) & 255);

        const id = parentId | (d << 8) | e;
        return id;
    }

    static extract(compact: number) {
        const parentId = compact >> 16;
        compact &= 0xffff;
        const type = compact >> 15;
        compact &= 0x7fff;
        const index = compact;
        return { parentId, type, index };
    }

    static compact2full(compact: number): string {
        const { parentId, type, index } = this.extract(compact);
        return type === 0 ? visual.CurveEdge.simpleName(parentId, index) : visual.Face.simpleName(parentId, index);
    }
}

// FIXME implement async:

// https://developer.mozilla.org/en-US/docs/Web/API/WebGL_API/WebGL_best_practices

function clientWaitAsync(gl: any, sync: any, flags: any, interval_ms: number) {
    return new Promise<void>((resolve, reject) => {
        function test() {
            const res = gl.clientWaitSync(sync, flags, 0);
            if (res == gl.WAIT_FAILED) {
                reject();
                return;
            }
            if (res == gl.TIMEOUT_EXPIRED) {
                setTimeout(test, interval_ms);
                return;
            }
            resolve();
        }
        test()
    });
}

async function getBufferSubDataAsync(
    gl: any, target: any, buffer: any, srcByteOffset: any, dstBuffer: any, dstOffset?: number, length?: number) {
    const sync = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();

    await clientWaitAsync(gl, sync, 0, 10);
    gl.deleteSync(sync);

    gl.bindBuffer(target, buffer);
    gl.getBufferSubData(target, srcByteOffset, dstBuffer, dstOffset, length);
    gl.bindBuffer(target, null);

    return dstBuffer;
}

async function readPixelsAsync(gl: any, x: any, y: any, w: any, h: any, format: any, type: any, dest: any) {
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, buf);
    gl.bufferData(gl.PIXEL_PACK_BUFFER, dest.byteLength, gl.STREAM_READ);
    gl.readPixels(x, y, w, h, format, type, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    await getBufferSubDataAsync(gl, gl.PIXEL_PACK_BUFFER, buf, 0, dest);

    gl.deleteBuffer(buf);
    return dest;
}

const UnpackDownscale = 255. / 256.; // 0..1 -> fraction (excluding 1)
const PackFactors = new THREE.Vector3(256. * 256. * 256., 256. * 256., 256.);
const UnpackFactors = new THREE.Vector4(1 / PackFactors.x, 1 / PackFactors.y, 1 / PackFactors.z, 1)
UnpackFactors.multiplyScalar(UnpackDownscale);
