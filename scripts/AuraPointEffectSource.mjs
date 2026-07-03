import { DISPOSITIONS } from "./constants.mjs";

export class AuraPointEffectSource extends foundry.canvas.sources.PointEffectSourceMixin(
  foundry.canvas.sources.BaseEffectSource
) {
  static sourceType = 'aura';
  static effectsCollection = 'auraEffects';
  graphics;
  id;
  sourceId;
  effect;

  constructor({ object, effect }) {
    super({ object });
    this.id = effect.id;
    this.sourceId = `${object.sourceId}.Aura.${effect.id}`;
    this.effect = effect;
  }

  static get defaultData() {
    return {
      ...super.defaultData,
      collisionTypes: ["move"],
      color: "#000000",
      disposition: [DISPOSITIONS.ANY],
      alpha: 0.25,
      radiusShape: "grid"
    };
  }

  get displayObject() {
    return this.graphics;
  }

  _configure() {
    this.graphics ??= new PIXI.Graphics();
    this.graphics.clear();
    this.graphics
      .beginFill(this.data.color, this.data.alpha)
      .lineStyle(2, this.data.color, 1)
      .drawShape(this.shape)
      .endFill();
  }

  _destroy() {
    this.graphics?.destroy();
  }

  _getPolygonConfiguration() {
    const config = {
      type: "universal",
      radius: this.radius + this.data.externalRadius,
      externalRadius: 0,
      angle: this.data.angle,
      rotation: this.data.rotation,
      priority: this.data.priority,
      source: this,
      boundaryShapes: []
    };
    config.boundaryShapes.push(this.#getRadiusBoundaryShape(config.radius + config.externalRadius));
    return config;
  }

  #getRadiusBoundaryShape(radius) {
    const shape = this.data.radiusShape ?? "grid";
    if (shape === "circle") return new PIXI.Circle(this.origin.x, this.origin.y, radius);
    if (shape === "diamond") {
      return new PIXI.Polygon([
        this.origin.x, this.origin.y - radius,
        this.origin.x + radius, this.origin.y,
        this.origin.x, this.origin.y + radius,
        this.origin.x - radius, this.origin.y
      ]);
    }
    if (shape === "square") {
      return new PIXI.Polygon([
        this.origin.x - radius, this.origin.y - radius,
        this.origin.x + radius, this.origin.y - radius,
        this.origin.x + radius, this.origin.y + radius,
        this.origin.x - radius, this.origin.y + radius
      ]);
    }
    return ((game.settings.get("core", "gridDiagonals") === 1) && game.settings.get("auraeffects", "exactCircles"))
      ? new PIXI.Circle(this.origin.x, this.origin.y, radius)
      : new PIXI.Polygon(canvas.grid.getCircle(this.origin, radius * canvas.grid.distance / canvas.grid.size));
  }

  _createShapes() {
    this._deleteEdges()
    const config = this._getPolygonConfiguration();
    const polygonClass = CONFIG.Canvas.polygonBackends[this.constructor.sourceType];
    for (const collisionType of this.data.collisionTypes) {
      config.boundaryShapes.push(polygonClass.create(this.origin, {type: collisionType}))
    }
    this.shape = polygonClass.create(this.origin, {...config, radius: config.radius * 20});
  }
}
