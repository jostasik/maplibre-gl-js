import {Event, ErrorEvent, Evented} from '../util/evented';

import {extend, pick} from '../util/util';
import {loadTileJson} from './load_tilejson';
import {TileBounds} from './tile_bounds';
import {ResourceType} from '../util/request_manager';

import type {Source} from './source';
import type {OverscaledTileID} from './tile_id';
import type {Map} from '../ui/map';
import type {Dispatcher} from '../util/dispatcher';
import type {Tile} from './tile';
import type {Callback} from '../types/callback';
import type {Cancelable} from '../types/cancelable';
import type {VectorSourceSpecification, PromoteIdSpecification} from '@maplibre/maplibre-gl-style-spec';

export type VectorTileSourceOptions = VectorSourceSpecification & {
    collectResourceTiming?: boolean;
}

/**
 * A source containing vector tiles in [Mapbox Vector Tile format](https://docs.mapbox.com/vector-tiles/reference/).
 * (See the [Style Specification](https://maplibre.org/maplibre-style-spec/) for detailed documentation of options.)
 *
 * @example
 * map.addSource('some id', {
 *     type: 'vector',
 *     url: 'https://demotiles.maplibre.org/tiles/tiles.json'
 * });
 *
 * @example
 * map.addSource('some id', {
 *     type: 'vector',
 *     tiles: ['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt'],
 *     minzoom: 6,
 *     maxzoom: 14
 * });
 *
 * @example
 * map.getSource('some id').setUrl("https://demotiles.maplibre.org/tiles/tiles.json");
 *
 * @example
 * map.getSource('some id').setTiles(['https://d25uarhxywzl1j.cloudfront.net/v0.1/{z}/{x}/{y}.mvt']);
 * @see [Add a vector tile source](https://maplibre.org/maplibre-gl-js-docs/example/vector-source/)
 * @see [Add a third party vector tile source](https://maplibre.org/maplibre-gl-js-docs/example/third-party/)
 */
export class VectorTileSource extends Evented implements Source {
    type: 'vector';
    id: string;
    minzoom: number;
    maxzoom: number;
    url: string;
    scheme: string;
    tileSize: number;
    promoteId: PromoteIdSpecification;

    _options: VectorSourceSpecification;
    _collectResourceTiming: boolean;
    dispatcher: Dispatcher;
    map: Map;
    bounds: [number, number, number, number];
    tiles: Array<string>;
    tileBounds: TileBounds;
    reparseOverscaled: boolean;
    isTileClipped: boolean;
    _tileJSONRequest: Cancelable;
    _loaded: boolean;

    constructor(id: string, options: VectorTileSourceOptions, dispatcher: Dispatcher, eventedParent: Evented) {
        super();
        this.id = id;
        this.dispatcher = dispatcher;

        this.type = 'vector';
        this.minzoom = 0;
        this.maxzoom = 22;
        this.scheme = 'xyz';
        this.tileSize = 512;
        this.reparseOverscaled = true;
        this.isTileClipped = true;
        this._loaded = false;

        extend(this, pick(options, ['url', 'scheme', 'tileSize', 'promoteId']));
        this._options = extend({type: 'vector'}, options);

        this._collectResourceTiming = options.collectResourceTiming;

        if (this.tileSize !== 512) {
            throw new Error('vector tile sources must have a tileSize of 512');
        }

        this.setEventedParent(eventedParent);
    }

    load = () => {
        this._loaded = false;
        this.fire(new Event('dataloading', {dataType: 'source'}));
        this._tileJSONRequest = loadTileJson(this._options, this.map._requestManager, (err, tileJSON) => {
            this._tileJSONRequest = null;
            this._loaded = true;
            this.map.style.sourceCaches[this.id].clearTiles();
            if (err) {
                this.fire(new ErrorEvent(err));
            } else if (tileJSON) {
                extend(this, tileJSON);
                if (tileJSON.bounds) this.tileBounds = new TileBounds(tileJSON.bounds, this.minzoom, this.maxzoom);

                // `content` is included here to prevent a race condition where `Style#_updateSources` is called
                // before the TileJSON arrives. this makes sure the tiles needed are loaded once TileJSON arrives
                // ref: https://github.com/mapbox/mapbox-gl-js/pull/4347#discussion_r104418088
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'metadata'}));
                this.fire(new Event('data', {dataType: 'source', sourceDataType: 'content'}));
            }
        });
    };

    loaded(): boolean {
        return this._loaded;
    }

    hasTile(tileID: OverscaledTileID) {
        return !this.tileBounds || this.tileBounds.contains(tileID.canonical);
    }

    onAdd(map: Map) {
        this.map = map;
        this.load();
    }

    setSourceProperty(callback: Function) {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
        }

        callback();

        this.load();
    }

    /**
     * Sets the source `tiles` property and re-renders the map.
     *
     * @param {string[]} tiles An array of one or more tile source URLs, as in the TileJSON spec.
     * @returns {VectorTileSource} this
     */
    setTiles(tiles: Array<string>) {
        this.setSourceProperty(() => {
            this._options.tiles = tiles;
        });

        return this;
    }

    /**
     * Sets the source `url` property and re-renders the map.
     *
     * @param {string} url A URL to a TileJSON resource. Supported protocols are `http:` and `https:`.
     * @returns {VectorTileSource} this
     */
    setUrl(url: string) {
        this.setSourceProperty(() => {
            this.url = url;
            this._options.url = url;
        });

        return this;
    }

    onRemove() {
        if (this._tileJSONRequest) {
            this._tileJSONRequest.cancel();
            this._tileJSONRequest = null;
        }
    }

    serialize = (): VectorSourceSpecification => {
        return extend({}, this._options);
    };

    loadTile(tile: Tile, callback: Callback<void>) {
        const url = tile.tileID.canonical.url(this.tiles, this.map.getPixelRatio(), this.scheme);
        const params = {
            request: this.map._requestManager.transformRequest(url, ResourceType.Tile),
            uid: tile.uid,
            tileID: tile.tileID,
            zoom: tile.tileID.overscaledZ,
            tileSize: this.tileSize * tile.tileID.overscaleFactor(),
            type: this.type,
            source: this.id,
            pixelRatio: this.map.getPixelRatio(),
            showCollisionBoxes: this.map.showCollisionBoxes,
            promoteId: this.promoteId
        };
        params.request.collectResourceTiming = this._collectResourceTiming;

        if (!tile.actor || tile.state === 'expired') {
            tile.actor = this.dispatcher.getActor();
            tile.request = tile.actor.send('loadTile', params, done.bind(this));
        } else if (tile.state === 'loading') {
            // schedule tile reloading after it has been loaded
            tile.reloadCallback = callback;
        } else {
            tile.request = tile.actor.send('reloadTile', params, done.bind(this));
        }

        function done(err, data) {
            delete tile.request;

            if (tile.aborted)
                return callback(null);

            if (err && err.status !== 404) {
                return callback(err);
            }

            if (data && data.resourceTiming)
                tile.resourceTiming = data.resourceTiming;

            if (this.map._refreshExpiredTiles && data) tile.setExpiryData(data);
            tile.loadVectorData(data, this.map.painter);

            callback(null);

            if (tile.reloadCallback) {
                this.loadTile(tile, tile.reloadCallback);
                tile.reloadCallback = null;
            }
        }
    }

    abortTile(tile: Tile) {
        if (tile.request) {
            tile.request.cancel();
            delete tile.request;
        }
        if (tile.actor) {
            tile.actor.send('abortTile', {uid: tile.uid, type: this.type, source: this.id}, undefined);
        }
    }

    unloadTile(tile: Tile) {
        tile.unloadVectorData();
        if (tile.actor) {
            tile.actor.send('removeTile', {uid: tile.uid, type: this.type, source: this.id}, undefined);
        }
    }

    hasTransition() {
        return false;
    }
}
