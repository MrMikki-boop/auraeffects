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
      alpha: 0.25
    };
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
    config.boundaryShapes.push(((game.settings.get("core", "gridDiagonals") === 1) && game.settings.get("auraeffects", "exactCircles"))
      ? new PIXI.Circle(this.origin.x, this.origin.y, config.radius + config.externalRadius)
      : new PIXI.Polygon(canvas.grid.getCircle(this.origin, (config.radius + config.externalRadius) * canvas.grid.distance / canvas.grid.size)));
    return config;
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