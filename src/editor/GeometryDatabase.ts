import * as THREE from 'three';
import c3d from '../../build/Release/c3d.node';
import { EditorSignals } from './Editor';
import { GeometryMemento } from './History';
import MaterialDatabase from './MaterialDatabase';
import { assertUnreachable } from '../util/Util';
import * as visual from './VisualModel';

const precision_distance: [number, number][] = [[0.1, 50], [0.001, 5], [0.0001, 0.5]];

export interface TemporaryObject {
    cancel(): void;
    commit(): Promise<visual.SpaceItem>;
}

export type TopologyData = { model: c3d.TopologyItem, view: Set<visual.Face | visual.Edge> };

export class GeometryDatabase {
    readonly temporaryObjects = new THREE.Scene();
    private readonly geometryModel = new Map<c3d.SimpleName, { view: visual.Item, model: c3d.Item }>(); // FIXME combine these two
    private readonly topologyModel = new Map<string, TopologyData>(); // parentId -> topologyId -> ...
    private readonly hidden = new Set<c3d.SimpleName>();

    constructor(
        private readonly materials: MaterialDatabase,
        private readonly signals: EditorSignals) { }

    private counter = 0;
    async addItem(model: c3d.Item): Promise<visual.Item> {
        const current = this.counter++;

        const view = await this.meshes(model, current, precision_distance);

        this.geometryModel.set(current, { view, model });
        if (view instanceof visual.Solid) {
            view.traverse(t => {
                if (t instanceof visual.Face || t instanceof visual.CurveEdge) {
                    this.addTopologyItem(model, t);
                }
            })
        }

        this.signals.objectAdded.dispatch(view);
        this.signals.sceneGraphChanged.dispatch();
        return view;
    }

    async addTemporaryItem(object: c3d.Item): Promise<TemporaryObject> {
        const mesh = await this.meshes(object, -1, [[0.005, 1]]);
        this.temporaryObjects.add(mesh);
        const that = this;
        return {
            cancel() {
                mesh.dispose();
                that.temporaryObjects.remove(mesh);
            },
            commit() {
                that.temporaryObjects.remove(mesh);
                return that.addItem(object);
            }
        }
    }

    removeItem(object: visual.Item) {
        const simpleName = object.simpleName;
        this.geometryModel.delete(simpleName);
        this.removeTopologyItems(object);
        this.hidden.delete(simpleName);

        this.signals.objectRemoved.dispatch(object);
        this.signals.sceneGraphChanged.dispatch();
    }

    lookupItemById(id: c3d.SimpleName): { view: visual.Item, model: c3d.Item } {
        const result = this.geometryModel.get(id);
        if (result === undefined) throw new Error(`invalid precondition: object ${id} missing from geometry model`);
        return result;
    }

    // FIXME rethink error messages and consider using Family rather than isA for curve3d?
    lookup(object: visual.Solid): c3d.Solid;
    lookup(object: visual.SpaceInstance<visual.Curve3D>): c3d.SpaceInstance;
    lookup(object: visual.PlaneInstance<visual.Region>): c3d.PlaneInstance;
    lookup(object: visual.Item): c3d.Item;
    lookup(object: visual.Item): c3d.Item {
        return this.lookupItemById(object.simpleName).model;
    }

    lookupTopologyItemById(id: string): TopologyData {
        const result = this.topologyModel.get(id);
        if (result === undefined) throw new Error(`invalid precondition: object ${id} missing from topology model`);
        return result;
    }

    lookupTopologyItem(object: visual.Face): c3d.Face;
    lookupTopologyItem(object: visual.CurveEdge): c3d.CurveEdge;
    lookupTopologyItem(object: visual.Edge | visual.Face): c3d.TopologyItem {
        const parent = object.parentItem;
        const { model: parentModel } = this.lookupItemById(parent.simpleName);
        if (!(parentModel instanceof c3d.Solid)) throw new Error("Invalid precondition");
        const solid = parentModel;

        if (object instanceof visual.Edge) {
            const result = solid.FindEdgeByName(object.userData.name);
            if (!result) throw new Error("cannot find edge");
            return result;
        } else if (object instanceof visual.Face) {
            const result = solid.GetFace(object.userData.index);
            if (!result) throw new Error("cannot find face");
            return result;
        }
        assertUnreachable(object);
    }

    find<T extends visual.Item>(klass: any): T[] {
        const result: visual.Item[] = [];
        for (const { view: visual } of this.geometryModel.values()) {
            if (visual instanceof klass) {
                result.push(visual);
            }
        }
        return result as T[];
    }

    get visibleObjects(): Array<visual.Item> {
        const { geometryModel, hidden } = this;
        const difference = [];
        for (const { view: visual } of geometryModel.values()) {
            if (!hidden.has(visual.simpleName)) difference.push(visual);
        }
        return difference;
    }

    private async meshes(obj: c3d.Item, id: c3d.SimpleName, precision_distance: [number, number][]): Promise<visual.Item> {
        let builder;
        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance:
                builder = new visual.SpaceInstanceBuilder<visual.Curve3D>();
                break;
            case c3d.SpaceType.PlaneInstance:
                builder = new visual.PlaneInstanceBuilder<visual.Region>();
                break;
            case c3d.SpaceType.Solid:
                builder = new visual.SolidBuilder();
                break;
            default:
                throw new Error("type not yet supported");
        }

        for (const [precision, distance] of precision_distance) {
            await this.object2mesh(builder, obj, id, precision, distance);
        }

        const result = builder.build();
        result.userData.simpleName = id;
        return result;
    }

    private async object2mesh(builder: visual.SpaceInstanceBuilder<visual.Curve3D> | visual.PlaneInstanceBuilder<visual.Region> | visual.SolidBuilder, obj: c3d.Item, id: c3d.SimpleName, sag: number, distance?: number): Promise<void> {
        const stepData = new c3d.StepData(c3d.StepType.SpaceStep, sag);
        const note = new c3d.FormNote(true, true, true, false, false);
        const item = await obj.CreateMesh_async(stepData, note);
        const mesh = item.Cast<c3d.Mesh>(c3d.SpaceType.Mesh);
        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance: {
                const instance = builder as visual.SpaceInstanceBuilder<visual.Curve3D>;
                const curve3D = new visual.Curve3DBuilder();
                const edges = mesh.GetEdges();
                let material = this.materials.line(obj as c3d.SpaceInstance);
                for (const edge of edges) {
                    const line = visual.CurveSegment.build(edge, material);
                    curve3D.addCurveSegment(line);
                }
                instance.addLOD(curve3D.build(), distance);
                break;
            }
            case c3d.SpaceType.PlaneInstance: {
                const instance = builder as visual.PlaneInstanceBuilder<visual.Region>;
                const grids = mesh.GetBuffers();
                if (grids.length != 1) throw new Error("Invalid precondition");
                const grid = grids[0];
                const material = this.materials.region();
                const region = visual.Region.build(grid, material);
                instance.addLOD(region, distance);
                break;
            }
            // case c3d.SpaceType.Point3D: {
            //     const apexes = mesh.GetApexes();
            //     const geometry = new THREE.BufferGeometry();
            //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(apexes, 3));
            //     const points = new THREE.Points(geometry, this.materials.point(obj));
            //     return points;
            // }
            case c3d.SpaceType.Solid: {
                const solid = builder as visual.SolidBuilder;
                const edges = new visual.CurveEdgeGroupBuilder();
                const lineMaterial = this.materials.line();
                const polygons = mesh.GetEdges(true);
                for (const edge of polygons) {
                    const line = visual.CurveEdge.build(edge, id, lineMaterial, this.materials.lineDashed());
                    edges.addEdge(line);
                }

                const faces = new visual.FaceGroupBuilder();
                const grids = mesh.GetBuffers();
                for (const grid of grids) {
                    const material = this.materials.mesh(grid, mesh.IsClosed());
                    const face = visual.Face.build(grid, id, material);
                    faces.addFace(face);
                }
                solid.addLOD(edges.build(), faces.build(), distance);
                break;
            }
            default: throw new Error("type not yet supported");
        }
    }

    private addTopologyItem<T extends visual.Face | visual.Edge>(parent: c3d.Item, t: T) {
        if (!(parent instanceof c3d.Solid)) throw new Error("invalid precondition");

        let topologyData = this.topologyModel.get(t.simpleName);
        let views;
        if (topologyData === undefined) {
            let model;
            if (t instanceof visual.Face) {
                model = parent.GetFace(t.userData.index);
            } else if (t instanceof visual.CurveEdge) {
                model = parent.FindEdgeByName(t.userData.name);
            } else throw new Error("invalid precondition");
            views = new Set<visual.Face | visual.Edge>();
            topologyData = { model, view: views }
            this.topologyModel.set(t.simpleName, topologyData);
        } else {
            views = topologyData.view;
        }
        views.add(t);
    }

    private removeTopologyItems(parent: visual.Item) {
        parent.traverse(o => {
            if (o instanceof visual.TopologyItem) {
                this.topologyModel.delete(o.simpleName);
            }
        })
    }

    hide(item: visual.Item) {
        this.hidden.add(item.simpleName);
    }

    unhide(item: visual.Item) {
        this.hidden.delete(item.simpleName);
    }

    saveToMemento(registry: Map<any, any>): GeometryMemento {
        return new GeometryMemento(
            new Map(this.geometryModel),
            new Map(this.topologyModel),
            new Set(this.hidden));
    }

    restoreFromMemento(m: GeometryMemento) {
        (this.geometryModel as GeometryDatabase['geometryModel']) = m.geometryModel;
        (this.topologyModel as GeometryDatabase['topologyModel']) = m.topologyModel;
        (this.hidden as GeometryDatabase['hidden']) = m.hidden;
    }
}