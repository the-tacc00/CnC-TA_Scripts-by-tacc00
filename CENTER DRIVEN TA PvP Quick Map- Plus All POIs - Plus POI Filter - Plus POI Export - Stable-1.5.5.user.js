// ==UserScript==
// @name        CENTER DRIVEN TA PvP Quick Map: Plus All POIs - Plus POI Filter - Plus POI Export - Stable
// @description Creates a detailed map of bases and POIs of the alliance and enemies, plus cached valid world POIs with icons and filters / game version: 25.2.1 / Last maintenance 24 March 2026
// @namespace   https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @include     https://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// @version     1.5.5
// @grant       none
// @author      Fixed by NetquiK | UPDATED by XDAAST | EXTENDED by tacc00 | Originally by zdoom and Bluepix
// ==/UserScript==

/* global qx, ClientLib, webfrontend, phe */

/*
 * Stable release notes (1.5.5)
 * ---------------------------
 * Adds POI CSV export with filters for POI type, minimum level, maximum level, and alliance selection.
 * Alliance export filter now supports selecting multiple top-10 alliances via checkboxes.
 * Fixes top-10 alliance selection so multi-select checkboxes, Top 10/Clear Alliances buttons, and export filtering all stay in sync.
 * Makes alliance export matching tolerant to spaces/punctuation differences between ranking names and POI owner names.
 * Root cause of the historical POI hover twitch:
 * - The hover info panel resized when long POI labels were shown.
 * - That resize shifted the map area under the mouse.
 * - The cursor then landed on a slightly different tile, which caused repeated hover enter/leave cycles.
 *
 * The fix kept map logic intact and stabilized the layout instead:
 * - fixed widths for the left sidebar
 * - fixed widths for hover info rows / labels / values
 * - no gameplay-targeting changes required
 */

(function () {
    /*
     * Main script factory.
     * Define all Qooxdoo classes used by the Quick Map and boot the singleton.
     */
    function create_cdccta_map_class() {
        qx.Class.define("cdccta_map", {
            type: "singleton",
            extend: qx.core.Object,

            /*
             * Entry point for the singleton.
             * Wait until world/endgame data is available, then initialize the script UI.
             */
            construct: function () {
                try {
                    var root = this;

                    var mapButton = new qx.ui.form.Button("PvP Quick Map").set({
                        enabled: false
                    });

                    var app = qx.core.Init.getApplication();
                    var optionsBar = app.getOptionsBar().getLayoutParent();
                    this.__mapButton = mapButton;

                    optionsBar.getChildren()[0].getChildren()[2].addAt(mapButton, 1);

                    var onReady = function () {
                        try {
                            var main = ClientLib.Data.MainData.GetInstance();
                            var world = main.get_World();
                            var endGame = main.get_EndGame().get_Hubs().d;

                            if (!world || !endGame) return;

                            var worldWidth = world.get_WorldWidth();
                            if (!worldWidth) return;

                            var factor = 500 / worldWidth;
                            var hubs = [];
                            var fortress = [];

                            for (var index in endGame) {
                                var currentHub = endGame[index];
                                if (currentHub.get_Type() === 1) {
                                    hubs.push([(currentHub.get_X() + 2) * factor, (currentHub.get_Y() + 2) * factor]);
                                }
                                if (currentHub.get_Type() === 3) {
                                    fortress = [(currentHub.get_X() + 2) * factor, (currentHub.get_Y() + 2) * factor];
                                }
                            }

                            if (hubs.length > 0) {
                                timer.stop();
                                root.__factor = factor;
                                root.__endGame.hubs = hubs;
                                root.__endGame.fortress = fortress;
                                root.__init();
                            }
                        } catch (e) {
                            console.log("onReady error:", e);
                        }
                    };

                    var timer = new qx.event.Timer(1000);
                    timer.addListener("interval", onReady, this);
                    timer.start();
                } catch (e) {
                    console.log(e.toString());
                }
                console.log("cdccta_map initialization completed");
            },

            members: {
                __mapButton: null,
                __allianceExist: null,
                __allianceName: null,
                __allianceId: null,
                __allianceHasRelations: false,
                __defaultAlliances: null,
                __selectedAlliances: null,
                __originalAlliances: null,
                __data: null,
                __totalProcesses: null,
                __completedProcesses: 0,
                __endGame: {},
                __isLoading: false,
                __factor: null,

                __allMapPois: null,
                __allMapPoisLoaded: false,
                __allMapPoisIndex: null,
                __poiKeys: null,
                __poiWatchTimer: null,
                __poiCacheSaveTimer: null,
                __poiRedrawTimer: null,
                __poiCacheLoaded: false,
                __poiCacheDirty: false,
                __poiSyncCount: 0,
                __poiWorldId: null,
                __poiRescanPending: false,
                __poiRescanTimer: null,
                __initialMapPois: null,
                __initialMapPoisIndex: null,
                __poiRestrictAfterClear: false,
                __poiAcceptWindow: null,
                __poiAcceptRadius: 100,
                __allPoiMode: true,

                __poiTypes: {
                    2: { key: "tiberium", label: "Tiberium Control Network", short: "TCN" },
                    3: { key: "crystal", label: "Crystal Control Network Hub", short: "CCNH" },
                    4: { key: "reactor", label: "Reactor", short: "RCT" },
                    5: { key: "tungsten", label: "Tungsten Compound", short: "TUN" },
                    6: { key: "uranium", label: "Uranium Compound", short: "URN" },
                    7: { key: "air", label: "Aircraft Guidance Network", short: "AGN" },
                    8: { key: "resonator", label: "Resonator Network", short: "RES" }
                },
                __poiFilters: null,

                /*
                 * Build top-level state, wire the main button, and prepare dialogs / map container.
                 */
                __init: function () {
                    try {
                        var root = this;
                        var data = ClientLib.Data.MainData.GetInstance();
                        var alliance_data = data.get_Alliance();
                        var alliance_exists = alliance_data.get_Exists();

                        if (alliance_exists) {
                            var alliance_name = alliance_data.get_Name();
                            var alliance_id = alliance_data.get_Id();
                            var alliance_relations = alliance_data.get_Relationships();

                            this.__allianceExist = true;
                            this.__allianceId = alliance_id;
                            this.__allianceName = alliance_name;

                            var selectedAlliancesList = [];
                            selectedAlliancesList[0] = [alliance_id, "alliance", alliance_name, 0];

                            if (alliance_relations != null) {
                                this.__allianceHasRelations = true;
                                for (var relIndex = 0; relIndex < alliance_relations.length; relIndex++) {
                                    var x = alliance_relations[relIndex];
                                    var type = x.Relationship,
                                        id = x.OtherAllianceId,
                                        name = x.OtherAllianceName;
                                    if ((type === 3) && (selectedAlliancesList.length < 9)) {
                                        selectedAlliancesList.push([id, "enemy", name, 0]);
                                    }
                                }
                            }
                            this.__defaultAlliances = selectedAlliancesList;
                        } else {
                            this.__allianceExist = false;
                            this.__defaultAlliances = [];
                        }

                        if (typeof Storage !== "undefined" && typeof localStorage.cdccta_map_settings !== "undefined") {
                            this.__selectedAlliances = JSON.parse(localStorage.cdccta_map_settings);
                        }

                        this.__loadPoiFilters();
                        this.__loadInitialPoiCache();
                        this.__captureInitialPoiBaselineFromClient();
                        this.__loadPoiCache();

                        this.__mapButton.setEnabled(true);
                        this.__mapButton.addListener("execute", function () {
                            root.getData();
                            cdccta_map.container.getInstance().open();
                        }, this);
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                __trimString: function (value) {
                    return value == null ? "" : String(value).replace(/^\s+|\s+$/g, "");
                },

                __loadPoiFilters: function () {
                    var defaults = {};
                    for (var t in this.__poiTypes) defaults[t] = true;
                    this.__poiFilters = defaults;

                    try {
                        if (typeof Storage !== "undefined" && typeof localStorage.cdccta_map_poi_filters !== "undefined") {
                            var saved = JSON.parse(localStorage.cdccta_map_poi_filters);
                            for (var k in defaults) {
                                if (typeof saved[k] !== "undefined") this.__poiFilters[k] = !!saved[k];
                            }
                        }
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                savePoiFilters: function () {
                    try {
                        if (typeof Storage !== "undefined") {
                            localStorage.cdccta_map_poi_filters = JSON.stringify(this.__poiFilters);
                        }
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                getPoiTypes: function () {
                    return this.__poiTypes;
                },

                getPoiTypeLabel: function (type) {
                    return this.__poiTypes[type] ? this.__poiTypes[type].label : ("POI " + type);
                },

                __topRankedAlliances: null,
                __topRankedAlliancesLoaded: false,

                getPoiOwnerAllianceOptions: function () {
                    this.__ensureAllMapPois();

                    var options = [];
                    var seen = {};
                    var pois = this.__allMapPois || [];

                    for (var i = 0; i < pois.length; i++) {
                        var ownerName = (pois[i].ownerAllianceName || "").replace(/^\s+|\s+$/g, "");
                        var label = ownerName || "Free";
                        var key = label.toLowerCase();
                        if (seen[key]) continue;
                        seen[key] = true;
                        options.push(label);
                    }

                    options.sort(function (a, b) {
                        if (a === "Free" && b !== "Free") return -1;
                        if (b === "Free" && a !== "Free") return 1;
                        return a.localeCompare(b);
                    });

                    return options;
                },

                getTopRankedAllianceOptions: function () {
                    var list = this.__topRankedAlliances || [];
                    return list.slice(0);
                },

                loadTopRankedAllianceOptions: function (callback) {
                    var root = this;
                    var done = function () {
                        if (callback) callback(root.getTopRankedAllianceOptions());
                    };

                    if (this.__topRankedAlliancesLoaded && this.__topRankedAlliances) {
                        done();
                        return;
                    }

                    var parseAllianceRow = function (row) {
                        if (!row) return null;

                        var id = null;
                        var name = "";

                        if (typeof row.ai !== "undefined" && typeof row.an !== "undefined") {
                            id = row.ai;
                            name = row.an;
                        } else if (typeof row.id !== "undefined" && typeof row.name !== "undefined") {
                            id = row.id;
                            name = row.name;
                        } else if (typeof row.i !== "undefined" && typeof row.n !== "undefined") {
                            id = row.i;
                            name = row.n;
                        } else if (typeof row.a !== "undefined" && typeof row.an !== "undefined") {
                            id = row.a;
                            name = row.an;
                        }

                        if (id == null || id === "" || !name) return null;

                        return {
                            id: parseInt(id, 10),
                            name: String(name)
                        };
                    };

                    ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("RankingGetData", {
                        firstIndex: 0,
                        lastIndex: 9,
                        ascending: true,
                        view: 1,
                        rankingType: 0,
                        sortColumn: 2
                    }, phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (context, data) {
                        var arr = [];

                        try {
                            if (data && data.a != null) {
                                for (var i = 0; i < data.a.length && arr.length < 10; i++) {
                                    var parsed = parseAllianceRow(data.a[i]);
                                    if (!parsed || isNaN(parsed.id)) continue;
                                    arr.push(parsed);
                                }
                            }
                        } catch (e) {
                            console.log("load top alliances error:", e);
                        }

                        root.__topRankedAlliances = arr;
                        root.__topRankedAlliancesLoaded = true;
                        done();
                    }), null);
                },

                exportPoisToCsv: function (settings) {
                    settings = settings || {};
                    this.__ensureAllMapPois();

                    var pois = this.__allMapPois || [];
                    var selectedTypes = settings.poiTypes || [];
                    var typeLookup = {};
                    for (var i = 0; i < selectedTypes.length; i++) {
                        typeLookup[String(selectedTypes[i])] = true;
                    }

                    var hasTypeFilter = selectedTypes.length > 0;

                    var minLevel = settings.minimumLevel;
                    var hasMinLevel = !(minLevel == null || minLevel === "" || isNaN(minLevel));
                    if (hasMinLevel) minLevel = parseInt(minLevel, 10);

                    var maxLevel = settings.maximumLevel;
                    var hasMaxLevel = !(maxLevel == null || maxLevel === "" || isNaN(maxLevel));
                    if (hasMaxLevel) maxLevel = parseInt(maxLevel, 10);

                    var allianceSelections = settings.alliances || [];
                    if ((!allianceSelections || !allianceSelections.length) && settings.allianceIds && settings.allianceIds.length) {
                        allianceSelections = [];
                        for (var as0 = 0; as0 < settings.allianceIds.length; as0++) {
                            allianceSelections.push({ id: settings.allianceIds[as0], name: "", label: "" });
                        }
                    }

                    var allianceFilter = this.__buildAllianceSelectionFilter(allianceSelections);
                    var hasAllianceFilter = !!allianceFilter.enabled;
                    var rows = [];

                    for (var p = 0; p < pois.length; p++) {
                        var poi = pois[p];
                        var ownerName = this.__trimString(poi.ownerAllianceName);
                        var ownerLabel = ownerName || "Free";

                        if (hasTypeFilter && !typeLookup[String(poi.t)]) continue;
                        if (hasMinLevel && poi.l < minLevel) continue;
                        if (hasMaxLevel && poi.l > maxLevel) continue;
                        if (hasAllianceFilter && !this.__poiMatchesAllianceSelection(poi, allianceFilter)) continue;

                        rows.push({
                            typeLabel: this.getPoiTypeLabel(poi.t),
                            level: parseInt(poi.l, 10) || 0,
                            coords: poi.wx + ":" + poi.wy,
                            ingameCoords: "[coords]" + poi.wx + ":" + poi.wy + "[/coords]",
                            owner: ownerLabel
                        });
                    }

                    rows.sort(function (a, b) {
                        var cmp = a.typeLabel.localeCompare(b.typeLabel);
                        if (cmp !== 0) return cmp;
                        if (a.level !== b.level) return a.level - b.level;
                        return a.coords.localeCompare(b.coords);
                    });

                    var lines = [["POI Type", "POI Level", "Coordinates", "In Game Coords", "Alliance owning it"]];
                    for (var r = 0; r < rows.length; r++) {
                        lines.push([rows[r].typeLabel, rows[r].level, rows[r].coords, rows[r].ingameCoords, rows[r].owner]);
                    }

                    var csv = [];
                    for (var l = 0; l < lines.length; l++) {
                        var line = [];
                        for (var c = 0; c < lines[l].length; c++) {
                            line.push(this.__escapeCsvValue(lines[l][c]));
                        }
                        csv.push(line.join(","));
                    }

                    var d = new Date();
                    var pad = function (n) {
                        return (n < 10 ? "0" : "") + n;
                    };
                    var fileName = "poi_export_" +
                        d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + "_" +
                        pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) + ".csv";

                    this.__downloadTextFile(fileName, csv.join("\r\n"), "text/csv;charset=utf-8;");

                    return {
                        count: rows.length,
                        fileName: fileName
                    };
                },

                __normalizeAllianceMatchKey: function (value) {
                    if (value == null) return "";
                    return this.__trimString(value)
                        .toLowerCase()
                        .replace(/[^a-z0-9]+/g, "");
                },
                __buildAllianceSelectionFilter: function (allianceSelections) {
                    var filter = {
                        enabled: false,
                        ownerIds: {},
                        ownerKeys: {}
                    };

                    if (!allianceSelections || !allianceSelections.length) return filter;

                    for (var i = 0; i < allianceSelections.length; i++) {
                        var sel = allianceSelections[i] || {};
                        var selId = sel.id;
                        var selName = sel.label || sel.name || "";
                        var selKey = this.__normalizeAllianceMatchKey(selName);

                        if (selId != null && selId !== "" && !isNaN(parseInt(selId, 10))) {
                            filter.ownerIds[String(parseInt(selId, 10))] = true;
                        }
                        if (selKey) {
                            filter.ownerKeys[selKey] = true;
                        }
                    }

                    filter.enabled = (Object.keys(filter.ownerIds).length > 0 || Object.keys(filter.ownerKeys).length > 0);
                    return filter;
                },

                __poiMatchesAllianceSelection: function (poi, filter) {
                    if (!filter || !filter.enabled) return true;

                    var ownerInfo = this.__getPoiAllianceFilterInfo(poi);
                    if (ownerInfo.id != null && filter.ownerIds[String(ownerInfo.id)]) return true;
                    if (ownerInfo.key && filter.ownerKeys[ownerInfo.key]) return true;
                    return false;
                },

                __getPoiAllianceFilterInfo: function (poi) {
                    var ownerName = this.__trimString(poi && poi.ownerAllianceName);
                    var ownerKey = this.__normalizeAllianceMatchKey(ownerName);
                    var ownerId = (poi && poi.ownerAllianceId != null && poi.ownerAllianceId !== "") ? parseInt(poi.ownerAllianceId, 10) : null;
                    if (ownerId != null && isNaN(ownerId)) ownerId = null;

                    return {
                        id: ownerId,
                        name: ownerName,
                        key: ownerKey
                    };
                },

                __escapeCsvValue: function (value) {
                    if (value == null) value = "";
                    value = String(value);
                    if (/[",\r\n]/.test(value)) {
                        return '"' + value.replace(/"/g, '""') + '"';
                    }
                    return value;
                },

                __downloadTextFile: function (fileName, text, mimeType) {
                    var blob = new Blob([text], { type: mimeType || "text/plain;charset=utf-8;" });
                    var url = window.URL.createObjectURL(blob);
                    var link = document.createElement("a");
                    link.style.display = "none";
                    link.href = url;
                    link.download = fileName;
                    document.body.appendChild(link);
                    link.click();

                    window.setTimeout(function () {
                        try {
                            document.body.removeChild(link);
                        } catch (e) {}
                        window.URL.revokeObjectURL(url);
                    }, 0);
                },

                isPoiTypeVisible: function (type) {
                    return !!this.__poiFilters[type];
                },

                setAllPoiMode: function (flag) {
                    this.__allPoiMode = !!flag;

                    if (this.__allPoiMode) {
                        this.__loadPoiCache();
                        this.__syncPoiCacheFromClient();
                        this.__startPoiWatcher();
                    } else {
                        this.__stopPoiWatcher();
                    }

                    try {
                        var win = cdccta_map.container.getInstance();
                        if (win) {
                            win.__updateAllPoiButton();
                            win.__updatePoiSummary();
                            win.drawCanvas();
                        }
                    } catch (e) {
                        console.log("setAllPoiMode error:", e);
                    }
                },

                toggleAllPoiMode: function () {
                    this.setAllPoiMode(!this.__allPoiMode);
                },

                isAllPoiMode: function () {
                    return !!this.__allPoiMode;
                },

                __detectPoiKeys: function () {
                    if (this.__poiKeys) return this.__poiKeys;

                    var ctorText = ClientLib.Data.WorldSector.WorldObjectPointOfInterest.prototype.$ctor.toString();

                    var match = ctorText.match(
                        /this\.([A-Z]{6})=-1[\s\S]+?this\.([A-Z]{6})=e&255,this\.([A-Z]{6})=e>>[\s\S]+?,this\.([A-Z]{6})=e>>11[\s\S]+?=4,this\.([A-Z]{6})[\s\S]+?,this\.([A-Z]{6})=o\.[A-Z]{6}/m
                    );

                    if (match) {
                        this.__poiKeys = {
                            allianceId: match[1],
                            level: match[2],
                            subtype: match[3],
                            extra: match[4],
                            allianceName: match[6]
                        };
                    } else {
                        this.__poiKeys = {
                            allianceId: "CEZLSJ",
                            level: "BTQLXV",
                            subtype: "SQIPYE",
                            allianceName: "EXGLIJ"
                        };
                    }

                    console.log("Detected POI keys:", this.__poiKeys);
                    return this.__poiKeys;
                },

                __getPoiStorageKey: function () {
                    try {
                        var main = ClientLib.Data.MainData.GetInstance();
                        var server = main.get_Server();
                        var worldId = (server && server.get_WorldId) ? server.get_WorldId() : "default";
                        this.__poiWorldId = worldId;
                        return "cdccta_map_poi_cache_" + worldId;
                    } catch (e) {
                        return "cdccta_map_poi_cache_default";
                    }
                },

                __getPoiInitialStorageKey: function () {
                    try {
                        var main = ClientLib.Data.MainData.GetInstance();
                        var server = main.get_Server();
                        var worldId = (server && server.get_WorldId) ? server.get_WorldId() : "default";
                        return "cdccta_map_poi_initial_cache_" + worldId;
                    } catch (e) {
                        return "cdccta_map_poi_initial_cache_default";
                    }
                },

                __rebuildPoiIndex: function () {
                    var idx = {};
                    var arr = this.__allMapPois || [];
                    for (var i = 0; i < arr.length; i++) {
                        idx[arr[i].i] = i;
                    }
                    this.__allMapPoisIndex = idx;
                },

                __rebuildInitialPoiIndex: function () {
                    var idx = {};
                    var arr = this.__initialMapPois || [];
                    for (var i = 0; i < arr.length; i++) {
                        idx[arr[i].i] = i;
                    }
                    this.__initialMapPoisIndex = idx;
                },

                __loadPoiCache: function () {
                    if (this.__poiCacheLoaded) return;

                    this.__allMapPois = [];
                    this.__allMapPoisIndex = {};

                    try {
                        if (typeof Storage !== "undefined") {
                            var key = this.__getPoiStorageKey();
                            var raw = localStorage.getItem(key);
                            if (raw) {
                                var parsed = JSON.parse(raw);
                                if (parsed && parsed.length) {
                                    this.__allMapPois = parsed;
                                }
                            }
                        }
                    } catch (e) {
                        console.log("load POI cache error:", e);
                        this.__allMapPois = [];
                    }

                    this.__rebuildPoiIndex();
                    this.__allMapPoisLoaded = !!(this.__allMapPois && this.__allMapPois.length);
                    this.__poiCacheLoaded = true;
                },

                __savePoiCache: function () {
                    try {
                        if (typeof Storage === "undefined") return;
                        if (!this.__poiCacheDirty) return;

                        var key = this.__getPoiStorageKey();
                        localStorage.setItem(key, JSON.stringify(this.__allMapPois || []));
                        this.__poiCacheDirty = false;
                    } catch (e) {
                        console.log("save POI cache error:", e);
                    }
                },

                __queuePoiCacheSave: function () {
                    var root = this;
                    if (this.__poiCacheSaveTimer) return;

                    this.__poiCacheSaveTimer = window.setTimeout(function () {
                        root.__poiCacheSaveTimer = null;
                        root.__savePoiCache();
                    }, 750);
                },

                __flushPoiCacheSave: function () {
                    if (this.__poiCacheSaveTimer) {
                        window.clearTimeout(this.__poiCacheSaveTimer);
                        this.__poiCacheSaveTimer = null;
                    }
                    this.__savePoiCache();
                },

                __loadInitialPoiCache: function () {
                    if (this.__initialMapPois != null) return;

                    this.__initialMapPois = [];
                    this.__initialMapPoisIndex = {};

                    try {
                        if (typeof Storage !== "undefined") {
                            var raw = localStorage.getItem(this.__getPoiInitialStorageKey());
                            if (raw) {
                                var parsed = JSON.parse(raw);
                                if (parsed && parsed.length) {
                                    this.__initialMapPois = parsed;
                                }
                            }
                        }
                    } catch (e) {
                        console.log("load initial POI cache error:", e);
                        this.__initialMapPois = [];
                    }

                    this.__rebuildInitialPoiIndex();
                },

                __saveInitialPoiCache: function () {
                    try {
                        if (typeof Storage === "undefined") return;
                        localStorage.setItem(this.__getPoiInitialStorageKey(), JSON.stringify(this.__initialMapPois || []));
                    } catch (e) {
                        console.log("save initial POI cache error:", e);
                    }
                },

                __captureInitialPoiBaselineFromClient: function () {
                    try {
                        this.__loadInitialPoiCache();
                        if (this.__initialMapPois && this.__initialMapPois.length) return;

                        var main = ClientLib.Data.MainData.GetInstance();
                        var world = main.get_World();
                        var factor = this.__factor;
                        var keys = this.__detectPoiKeys();
                        var fresh = [];
                        var seen = {};

                        if (!world || !world.GetPOIs) return;

                        var poiStore = world.GetPOIs();
                        var poiMap = poiStore && poiStore.d;
                        if (!poiMap) return;
                        for (var id in poiMap) {
                            var rec = this.__buildPoiRecord(poiMap[id], keys, factor);
                            if (!rec || seen[rec.i]) continue;

                            try {
                                var obj = world.GetObjectFromPosition(rec.wx, rec.wy);
                                if (obj && typeof obj.Type !== "undefined" && obj.Type !== 4) {
                                    continue;
                                }
                            } catch (e1) {}

                            seen[rec.i] = true;
                            fresh.push(rec);
                        }

                        if (fresh.length) {
                            this.__initialMapPois = fresh;
                            this.__rebuildInitialPoiIndex();
                            this.__saveInitialPoiCache();
                        }
                    } catch (e) {
                        console.log("capture initial POI baseline error:", e);
                    }
                },

                __clearLivePoiStore: function () {
                    try {
                        var main = ClientLib.Data.MainData.GetInstance();
                        var world = main.get_World();
                        var poiStore = world && world.GetPOIs ? world.GetPOIs() : null;
                        var poiMap = poiStore && poiStore.d ? poiStore.d : null;

                        if (!poiMap) return;

                        try {
                            for (var pid in poiMap) {
                                delete poiMap[pid];
                            }
                        } catch (e0) {}

                        try {
                            poiStore.d = {};
                        } catch (e1) {}
                    } catch (e) {
                        console.log("clear live POI store error:", e);
                    }
                },

                __hasClientPois: function () {
                    try {
                        var main = ClientLib.Data.MainData.GetInstance();
                        var world = main.get_World();
                        var poiStore = world && world.GetPOIs ? world.GetPOIs() : null;
                        var poiMap = poiStore && poiStore.d ? poiStore.d : null;

                        if (!poiMap) return false;

                        for (var id in poiMap) {
                            return true;
                        }
                    } catch (e) {
                        console.log("has client POIs error:", e);
                    }

                    return false;
                },

                __shouldAcceptPoiRecord: function (rec) {
                    if (!rec) return false;
                    if (!this.__poiRestrictAfterClear) return true;

                    if (this.__allMapPoisIndex && typeof this.__allMapPoisIndex[rec.i] !== "undefined") return true;

                    this.__loadInitialPoiCache();
                    if (this.__initialMapPoisIndex && typeof this.__initialMapPoisIndex[rec.i] !== "undefined") return true;

                    if (!this.__poiAcceptWindow) return false;

                    var dx = rec.wx - this.__poiAcceptWindow.x;
                    var dy = rec.wy - this.__poiAcceptWindow.y;
                    var radius = this.__poiAcceptWindow.r || this.__poiAcceptRadius;

                    return ((dx * dx) + (dy * dy)) <= (radius * radius);
                },

                __beginPoiRescanAfterMapClick: function () {
                    var root = this;

                    if (!this.__poiRestrictAfterClear && !this.__poiRescanPending) return;

                    var win = cdccta_map.container.getInstance();
                    var px = win ? win.__pointerX : null;
                    var py = win ? win.__pointerY : null;

                    if (px == null || py == null) return;

                    this.__poiAcceptWindow = {
                        x: px,
                        y: py,
                        r: this.__poiAcceptRadius
                    };

                    this.__stopPoiWatcher();
                    this.__clearLivePoiStore();

                    if (this.__poiRescanTimer) {
                        window.clearInterval(this.__poiRescanTimer);
                        this.__poiRescanTimer = null;
                    }

                    var attempts = 0;
                    this.__poiRescanTimer = window.setInterval(function () {
                        attempts++;

                        var changed = root.__syncPoiCacheFromClient();
                        var hasPois = root.__hasClientPois();

                        if (changed) {
                            root.__redrawPoiIfOpen();
                        }

                        if (hasPois || attempts >= 20) {
                            window.clearInterval(root.__poiRescanTimer);
                            root.__poiRescanTimer = null;
                            root.__poiRescanPending = false;
                            root.__poiAcceptWindow = null;

                            if (root.__allPoiMode) {
                                root.__startPoiWatcher();
                            }

                            root.__redrawPoiIfOpen();
                        }
                    }, 500);
                },

                clearPoiCache: function () {
                    try {
                        this.__stopPoiWatcher();

                        if (this.__poiRescanTimer) {
                            window.clearInterval(this.__poiRescanTimer);
                            this.__poiRescanTimer = null;
                        }

                        this.__loadInitialPoiCache();
                        this.__clearLivePoiStore();

                        this.__allMapPois = [];
                        this.__allMapPoisIndex = {};
                        this.__allMapPoisLoaded = false;
                        this.__poiCacheLoaded = true;
                        this.__poiCacheDirty = true;
                        this.__poiSyncCount = 0;
                        this.__poiRescanPending = false;
                        this.__poiRestrictAfterClear = true;
                        this.__poiAcceptWindow = null;

                        if (typeof Storage !== "undefined") {
                            localStorage.removeItem(this.__getPoiStorageKey());
                        }

                        this.__savePoiCache();
                        this.__redrawPoiIfOpen();
                    } catch (e) {
                        console.log("clear POI cache error:", e);
                    }
                },

                __buildPoiRecord: function (p, keys, factor) {
                    if (!p) return null;

                    var subtype = p[keys.subtype];
                    if (subtype == null) return null;

                    subtype = parseInt(subtype, 10);

                    if (!subtype || subtype < 1 || subtype > 7) return null;

                    var worldId = p.worldId;
                    if (worldId == null) return null;

                    var wx = (worldId >> 16) & 0xffff;
                    var wy = worldId & 0xffff;

                    return {
                        i: "poi_" + worldId,
                        worldId: worldId,
                        l: parseInt(p[keys.level], 10) || 0,
                        t: subtype + 1,
                        x: wx * factor,
                        y: wy * factor,
                        wx: wx,
                        wy: wy,
                        ownerAllianceId: (p[keys.allianceId] === -1 ? null : p[keys.allianceId]),
                        ownerAllianceName: p[keys.allianceName] || ""
                    };
                },

                __mergePoiRecord: function (rec) {
                    if (!rec) return false;

                    if (!this.__allMapPois) this.__allMapPois = [];
                    if (!this.__allMapPoisIndex) this.__allMapPoisIndex = {};

                    var idx = this.__allMapPoisIndex[rec.i];
                    if (idx == null) {
                        this.__allMapPoisIndex[rec.i] = this.__allMapPois.length;
                        this.__allMapPois.push(rec);
                        this.__poiCacheDirty = true;
                        return true;
                    }

                    var cur = this.__allMapPois[idx];
                    var changed =
                        cur.l !== rec.l ||
                        cur.t !== rec.t ||
                        cur.ownerAllianceId !== rec.ownerAllianceId ||
                        cur.ownerAllianceName !== rec.ownerAllianceName ||
                        cur.x !== rec.x ||
                        cur.y !== rec.y;

                    if (changed) {
                        this.__allMapPois[idx] = rec;
                        this.__poiCacheDirty = true;
                        return true;
                    }

                    return false;
                },

                __syncPoiCacheFromClient: function () {
                    try {
                        var main = ClientLib.Data.MainData.GetInstance();
                        var world = main.get_World();
                        var factor = this.__factor;
                        var keys = this.__detectPoiKeys();
                        var changed = false;

                        if (!world || !world.GetPOIs) {
                            return false;
                        }

                        var poiStore = world.GetPOIs();
                        var poiMap = poiStore && poiStore.d;
                        if (!poiMap) {
                            return false;
                        }

                        for (var id in poiMap) {
                            var p = poiMap[id];
                            var rec = this.__buildPoiRecord(p, keys, factor);
                            if (!rec) continue;
                            if (!this.__shouldAcceptPoiRecord(rec)) continue;

                            try {
                                var obj = world.GetObjectFromPosition(rec.wx, rec.wy);
                                if (obj && typeof obj.Type !== "undefined" && obj.Type !== 4) {
                                    continue;
                                }
                            } catch (e1) {}

                            if (this.__mergePoiRecord(rec)) changed = true;
                        }

                        if (changed) {
                            this.__allMapPoisLoaded = true;
                            this.__queuePoiCacheSave();
                        }

                        return changed;
                    } catch (e) {
                        console.log("sync POI cache error:", e);
                        return false;
                    }
                },

                __redrawPoiIfOpen: function () {
                    try {
                        var win = cdccta_map.container.getInstance();
                        if (!win || !win.getLayoutParent() || !win.isVisible()) return;

                        if (this.__data) {
                            win.receivedData = this.__data;
                        }
                        win.__updateList();
                        win.drawCanvas();
                    } catch (e) {
                        console.log("redraw open POI map error:", e);
                    }
                },

                __queuePoiRedraw: function () {
                    var root = this;
                    if (this.__poiRedrawTimer) return;

                    this.__poiRedrawTimer = window.setTimeout(function () {
                        root.__poiRedrawTimer = null;
                        root.__redrawPoiIfOpen();
                    }, 100);
                },

                /*
                 * Start the background watcher that keeps POI cache data in sync with the world state
                 * while the script window is open.
                 */
                __startPoiWatcher: function () {
                    var root = this;
                    if (this.__poiWatchTimer) return;

                    this.__poiWatchTimer = window.setInterval(function () {
                        var changed = root.__syncPoiCacheFromClient();
                        if (changed) {
                            root.__poiSyncCount++;
                            root.__queuePoiRedraw();
                        }
                    }, 1000);
                },

                __stopPoiWatcher: function () {
                    if (this.__poiWatchTimer) {
                        window.clearInterval(this.__poiWatchTimer);
                        this.__poiWatchTimer = null;
                    }
                    if (this.__poiRedrawTimer) {
                        window.clearTimeout(this.__poiRedrawTimer);
                        this.__poiRedrawTimer = null;
                    }
                    this.__flushPoiCacheSave();
                },

                /*
                 * Request alliance relationship data and refresh the map payload.
                 * This is the main public refresh entry used after option changes.
                 */
                getData: function () {
                    if (this.__isLoading === true) return;
                    this.__isLoading = true;

                    this.__loadPoiCache();
                    this.__syncPoiCacheFromClient();
                    this.__captureInitialPoiBaselineFromClient();

                    if (this.__allPoiMode) {
                        this.__startPoiWatcher();
                    } else {
                        this.__stopPoiWatcher();
                    }

                    var arr = (!this.__selectedAlliances || !this.__selectedAlliances.length) ? this.__defaultAlliances : this.__selectedAlliances;
                    this.__originalAlliances = arr;

                    if (arr != null && arr.length) {
                        this.__data = [];
                        this.__totalProcesses = arr.length;
                        this.__completedProcesses = 0;

                        for (var i = 0; i < arr.length; i++) {
                            this.__getAlliance(arr[i][0], arr[i][1], arr[i][3], i);
                        }
                    } else {
                        this.__onComplete();
                    }
                },

                __ensureAllMapPois: function () {
                    this.__loadPoiCache();
                    this.__syncPoiCacheFromClient();
                    this.__captureInitialPoiBaselineFromClient();

                    if (this.__allPoiMode) {
                        this.__startPoiWatcher();
                    } else {
                        this.__stopPoiWatcher();
                    }
                },

                __getAlliance: function (aid, type, color, index) {
                    try {
                        var alliance = {},
                            root = this,
                            factor = this.__factor;

                        alliance.id = aid;
                        alliance.players = {};

                        var getBases = function (pid, pn, p, tp) {
                            ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("GetPublicPlayerInfo", { id: pid },
                                                                                               phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (context, data) {
                                if (data.c != null) {
                                    var totalBases = data.c.length;
                                    var player = {};
                                    var bases = [];

                                    if (totalBases === 0 && p === tp - 1) {
                                        root.__completedProcesses++;
                                        var loader0 = cdccta_map.container.getInstance().loader;
                                        loader0.setValue("Loading: " + root.__completedProcesses + "/" + root.__totalProcesses);
                                        if (root.__completedProcesses === root.__totalProcesses) root.__onProcessComplete();
                                    }

                                    for (var b = 0; b < data.c.length; b++) {
                                        var id = data.c[b].i;
                                        var name = data.c[b].n;
                                        var x = data.c[b].x * factor;
                                        var y = data.c[b].y * factor;
                                        bases.push([x, y, name, id]);

                                        if ((p === tp - 1) && (b === totalBases - 1)) {
                                            root.__completedProcesses++;
                                            var loader = cdccta_map.container.getInstance().loader;
                                            loader.setValue("Loading: " + root.__completedProcesses + "/" + root.__totalProcesses);
                                        }
                                        if (root.__completedProcesses === root.__totalProcesses) root.__onProcessComplete();
                                    }
                                    player.id = pid;
                                    player.name = pn;
                                    player.bases = bases;
                                    alliance.players[pn] = player;
                                }
                            }), null);
                        };

                        ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("GetPublicAllianceInfo", { id: aid },
                                                                                           phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (context, data) {
                            if (data.i == null) {
                                this.__totalProcesses--;
                                if (this.__selectedAlliances && this.__selectedAlliances.filter) {
                                    this.__selectedAlliances = this.__selectedAlliances.filter(function (v) { return v[0] !== alliance.id; });
                                }
                                this.__totalProcesses === 0 && root.__onProcessComplete();
                                return;
                            }
                            if (data.n != null) alliance.name = data.n;
                            if (data.m != null) {
                                for (var p = 0; p < data.m.length; p++) {
                                    var playerName = data.m[p].n;
                                    var playerId = data.m[p].i;
                                    getBases(playerId, playerName, p, data.m.length);
                                }
                                root.__data.push([alliance, type, color]);
                            }
                        }), null);

                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                __clean: function () {
                    (this.__selectedAlliances && !this.__selectedAlliances.length) && (this.__selectedAlliances = this.__defaultAlliances);
                    this.getData();
                    if (this.__selectedAlliances && this.__selectedAlliances.length) {
                        localStorage.cdccta_map_settings = JSON.stringify(this.__selectedAlliances);
                    }
                },

                __onComplete: function () {
                    this.__isLoading = false;
                    var win = cdccta_map.container.getInstance();
                    win.receivedData = [];
                    win.__updateList();
                    win.drawCanvas();
                    win.loader.setValue("Completed");
                },

                __onProcessComplete: function () {
                    this.__isLoading = false;
                    if (this.__selectedAlliances && this.__selectedAlliances !== this.__originalAlliances) {
                        this.__clean();
                    } else {
                        var win = cdccta_map.container.getInstance();
                        win.receivedData = this.__data;
                        win.__updateList();
                        win.drawCanvas();
                        win.loader.setValue("Completed");
                        this.__totalProcesses = null;
                        this.__completedProcesses = 0;
                        setTimeout(function () {
                            win.loader.setValue("");
                        }, 3000);
                    }
                }
            }
        });

        qx.Class.define("cdccta_map.container", {
            type: "singleton",
            extend: qx.ui.container.Composite,

            /*
             * Entry point for the singleton.
             * Wait until world/endgame data is available, then initialize the script UI.
             */
            construct: function () {
                try {
                    this.base(arguments);
                    this.setLayout(new qx.ui.layout.Canvas);

                    var worldWidth = ClientLib.Data.MainData.GetInstance().get_World().get_WorldWidth();
                    var factor = 500 / worldWidth;
                    this.__factor = factor;

                    var zoomIn = new qx.ui.form.Button("+").set({ width: 30 });
                    var zoomOut = new qx.ui.form.Button("-").set({ width: 30, enabled: false });
                    var zoomReset = new qx.ui.form.Button("R").set({ width: 30, enabled: false });
                    var clearPoiCacheBtn = new qx.ui.form.Button("Clear POI Cache").set({ width: 120 });
                    var exportPoiCsvBtn = new qx.ui.form.Button("Export POI List CSV").set({ width: 120 });

                    var grid = new qx.ui.container.Composite(new qx.ui.layout.Grid(3, 1));
                    var info = new qx.ui.container.Composite(new qx.ui.layout.VBox()).set({
                        minHeight: 300,
                        width: 200,
                        minWidth: 200,
                        maxWidth: 200,
                        padding: 10
                    });
                    var canvasContainer = new qx.ui.container.Composite(new qx.ui.layout.VBox(1)).set({
                        width: 500,
                        height: 500
                    });

                    var rightBar = new qx.ui.container.Composite(new qx.ui.layout.VBox(10));
                    var leftBar = new qx.ui.container.Composite(new qx.ui.layout.VBox(10));
                    var widget = new qx.ui.core.Widget().set({
                        width: 900,
                        height: 800
                    });

                    var div = new qx.html.Element("div", null, { id: "canvasContainer" });

                    var li1 = new qx.ui.form.ListItem("All", null, "all");
                    var li2 = new qx.ui.form.ListItem("My Bases", null, "bases");
                    var li3 = new qx.ui.form.ListItem("My Alliance", null, "alliance");
                    var li4 = new qx.ui.form.ListItem("Selected", null, "selected");
                    var displayMode = new qx.ui.form.SelectBox().set({ height: 28 });
                    displayMode.add(li1);
                    displayMode.add(li2);
                    displayMode.add(li3);
                    displayMode.add(li4);

                    var zoomBar = new qx.ui.container.Composite(new qx.ui.layout.HBox(15));

                    var displayOptions = new qx.ui.form.RadioGroup().set({
                        allowEmptySelection: true
                    });
                    var displayOptionsC = new qx.ui.container.Composite(new qx.ui.layout.HBox(10));
                    displayOptionsC.setTextColor("#aaaaaa");
                    var bothOpt = new qx.ui.form.RadioButton("Both").set({
                        model: "both",
                        group: displayOptions
                    });
                    var basesOpt = new qx.ui.form.RadioButton("Base").set({
                        model: "bases",
                        group: displayOptions
                    });
                    var poisOpt = new qx.ui.form.RadioButton("Poi").set({
                        model: "pois",
                        group: displayOptions
                    });

                    displayOptionsC.add(bothOpt);
                    displayOptionsC.add(basesOpt);
                    displayOptionsC.add(poisOpt);

                    var allianceList = new qx.ui.form.List().set({
                        font: "font_size_11",
                        height: 165
                    });
                    var editAlliance = new qx.ui.form.Button("Edit Alliances").set({
                        toolTipText: "Change the Alliances shown on Map",
                        width: 100,
                        alignY: "top"
                    });
                    var poiFiltersBtn = new qx.ui.form.Button("POI Filters").set({
                        toolTipText: "Choose POI types shown on Map",
                        width: 100,
                        alignY: "top"
                    });
                    var poiSummary = new qx.ui.basic.Label("").set({
                        rich: true,
                        wrap: true,
                        maxWidth: 180,
                        textColor: "#c7d7dc"
                    });

                    var label = new qx.ui.basic.Label("Transparency");
                    var slider = new qx.ui.form.Slider().set({
                        minimum: 30,
                        maximum: 100,
                        value: 100
                    });
                    var coordsField = new qx.ui.form.TextField().set({
                        maxWidth: 100,
                        textAlign: "center",
                        readOnly: true,
                        alignX: "center"
                    });
                    var loader = new qx.ui.basic.Label().set({
                        marginTop: 100
                    });

                    grid.set({
                        minWidth: 1500,
                        backgroundColor: "#0b2833",
                        minHeight: 524,
                        margin: 3,
                        paddingTop: 10
                    });
                    rightBar.set({
                        maxWidth: 220,
                        minWidth: 160,
                        paddingTop: 30,
                        paddingRight: 10
                    });
                    leftBar.set({
                        width: 220,
                        maxWidth: 220,
                        minWidth: 220,
                        paddingTop: 30,
                        paddingLeft: 10
                    });

                    var hints = [
                        [zoomIn, "Zoom in"],
                        [zoomOut, "Zoom out"],
                        [zoomReset, "Reset zoom"],
                        [basesOpt, "Show bases only"],
                        [poisOpt, "Show POIs only"],
                        [bothOpt, "Show bases and POIs"]
                    ];
                    for (var i = 0; i < hints.length; i++) {
                        var tooltip = new qx.ui.tooltip.ToolTip(hints[i][1]);
                        hints[i][0].setToolTip(tooltip);
                    }

                    zoomBar.add(zoomIn);
                    zoomBar.add(zoomOut);
                    zoomBar.add(zoomReset);

                    rightBar.add(zoomBar);
                    rightBar.add(displayMode);
                    rightBar.add(displayOptionsC);
                    rightBar.add(allianceList);
                    rightBar.add(editAlliance);
                    rightBar.add(poiFiltersBtn);
                    rightBar.add(clearPoiCacheBtn);
                    rightBar.add(exportPoiCsvBtn);
                    rightBar.add(poiSummary);
                    rightBar.add(label);
                    rightBar.add(slider);

                    leftBar.add(coordsField);
                    leftBar.add(info);
                    leftBar.add(loader);

                    canvasContainer.add(widget);
                    widget.getContentElement().add(div);
                    grid.add(leftBar, { row: 1, column: 1 });
                    grid.add(rightBar, { row: 1, column: 3 });
                    grid.add(canvasContainer, { row: 1, column: 2 });

                    this.info = info;
                    this.coordsField = coordsField;
                    this.allianceList = allianceList;
                    this.panel = [zoomOut, zoomReset, zoomIn, displayOptionsC, displayMode, allianceList, editAlliance, poiFiltersBtn, clearPoiCacheBtn, exportPoiCsvBtn];
                    this.loader = loader;
                    this.zoomIn = zoomIn;
                    this.zoomOut = zoomOut;
                    this.zoomReset = zoomReset;
                    this.poiSummary = poiSummary;

                    var cont = document.createElement("div"),
                        mask = document.createElement("div"),
                        canvas = document.createElement("canvas"),
                        ctx = canvas.getContext("2d"),
                        root = this;

                    cont.style.width = "500px";
                    cont.style.height = "500px";
                    cont.style.position = "absolute";
                    cont.style.overflow = "hidden";
                    cont.style.backgroundColor = "#0b2833";

                    canvas.style.position = "absolute";
                    canvas.style.backgroundColor = "#0b2833";

                    mask.style.position = "absolute";
                    mask.style.width = "500px";
                    mask.style.height = "500px";
                    mask.style.background = 'url("") center center no-repeat';

                    this.canvas = canvas;
                    this.mask = mask;
                    this.ctx = ctx;
                    this.__hitCanvas = document.createElement("canvas");
                    this.__hitCtx = this.__hitCanvas.getContext("2d", { willReadFrequently: true });
                    this.__poiHitMap = {};

                    var __zoomIn = function () {
                        if (root.scale < 12) root.__scaleMap("up");
                    };
                    var __zoomOut = function () {
                        if (root.scale > 1) root.__scaleMap("down");
                    };
                    var __zoomReset = function () {
                        canvas.width = 500;
                        canvas.height = 500;
                        canvas.style.left = 0;
                        canvas.style.top = 0;
                        root.scale = 1;
                        root.drawCanvas();
                        zoomIn.setEnabled(true);
                        zoomOut.setEnabled(false);
                        zoomReset.setEnabled(false);
                    };

                    cont.appendChild(canvas);
                    cont.appendChild(mask);
                    root.__draggable(mask);
                    root.resetMap();

                    slider.addListener("changeValue", function (e) {
                        if (e.getData()) {
                            var val = e.getData() / 100;
                            this.setOpacity(val);
                            slider.setToolTipText(" " + val * 100 + "% ");
                        }
                    }, this);

                    allianceList.addListener("changeSelection", function (e) {
                        if ((root.__displayM === "bases") || (root.__displayM === "alliance") || !e.getData()[0]) return;
                        var aid = e.getData()[0].getModel();
                        root.__selectedA = aid;
                        root.drawCanvas();
                    }, this);

                    displayMode.addListener("changeSelection", function (e) {
                        var dm = e.getData()[0].getModel();
                        root.__displayM = dm;
                        root.__updateList();

                        if (dm === "bases") {
                            displayOptions.setSelection([basesOpt]);
                            poisOpt.setEnabled(false);
                            bothOpt.setEnabled(false);
                            root.__displayO = "bases";
                        } else {
                            if (!poisOpt.isEnabled()) poisOpt.setEnabled(true);
                            if (!bothOpt.isEnabled()) bothOpt.setEnabled(true);
                            displayOptions.setSelection([bothOpt]);
                            root.__displayO = "both";
                        }
                        root.drawCanvas();
                    }, this);

                    displayOptions.addListener("changeSelection", function (e) {
                        if (!e.getData()[0]) return;
                        var dop = e.getData()[0].getModel();
                        root.__displayO = dop;
                        root.drawCanvas();
                    }, this);

                    editAlliance.addListener("execute", function () {
                        cdccta_map.options.getInstance().open();
                    }, this);

                    poiFiltersBtn.addListener("execute", function () {
                        cdccta_map.poioptions.getInstance().open();
                    }, this);

                    clearPoiCacheBtn.addListener("execute", function () {
                        cdccta_map.getInstance().clearPoiCache();
                    }, this);

                    exportPoiCsvBtn.addListener("execute", function () {
                        cdccta_map.poiexport.getInstance().open();
                    }, this);

                    var desktop = qx.core.Init.getApplication().getDesktop();
                    desktop.addListener("resize", this._onResize, this);

                    zoomIn.addListener("execute", __zoomIn, this);
                    zoomOut.addListener("execute", __zoomOut, this);
                    zoomReset.addListener("execute", __zoomReset, this);


                    this.add(grid);

                    this.wdgAnchor = new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_tl1.png").set({
                        width: 3,
                        height: 32
                    });
                    this.__imgTopRightCorner = new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_tr.png").set({
                        width: 34,
                        height: 35
                    });
                    this._add(this.__imgTopRightCorner, { right: 0, top: 0, bottom: 28 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_r.png").set({
                        width: 3,
                        height: 1,
                        allowGrowY: true,
                        scale: true
                    }), { right: 0, top: 35, bottom: 29 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_br.png").set({
                        width: 5,
                        height: 28,
                        allowGrowY: true,
                        scale: true
                    }), { right: 0, bottom: 0 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_b.png").set({
                        width: 1,
                        height: 3,
                        allowGrowX: true,
                        scale: true
                    }), { right: 5, bottom: 0, left: 5 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_bl.png").set({
                        width: 5,
                        height: 29
                    }), { left: 0, bottom: 0 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_l.png").set({
                        width: 3,
                        height: 1,
                        allowGrowY: true,
                        scale: true
                    }), { left: 0, bottom: 29, top: 32 });
                    this._add(this.wdgAnchor, { left: 0, top: 0 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_tl2.png").set({
                        width: 25,
                        height: 5
                    }), { left: 3, top: 0 });
                    this._add(new qx.ui.basic.Image("webfrontend/ui/common/frame_basewin/frame_basewindow_t.png").set({
                        width: 1,
                        height: 3,
                        allowGrowX: true,
                        scale: true
                    }), { left: 28, right: 34, top: 0 });

                    this.__btnClose = new webfrontend.ui.SoundButton(null, "FactionUI/icons/icon_close_button.png").set({
                        appearance: "button-close",
                        width: 23,
                        height: 23,
                        toolTipText: this.tr("tnf:close base view")
                    });
                    this.__btnClose.addListener("execute", this._onClose, this);
                    this._add(this.__btnClose, { top: 6, right: 5 });

                    var onLoaded = function () {
                        var counter = 0;
                        var check = function () {
                            if (counter > 60) return;
                            var htmlDiv = document.getElementById("canvasContainer");
                            (htmlDiv) ? htmlDiv.appendChild(cont) : setTimeout(check, 1000);
                            counter++;
                        };
                        check();
                    };
                    onLoaded();

                } catch (e) {
                    console.log(e.toString());
                }
                console.log("container creation completed");
            },

            members: {
                info: null,
                coordsField: null,
                panel: null,
                loader: null,
                canvas: null,
                mask: null,
                ctx: null,
                receivedData: null,
                allianceList: null,
                poiSummary: null,
                allPoiBtn: null,
                circles: [53, 85, 113, 145, 242],
                scale: 1,
                selectedBase: false,
                elements: [],
                locations: [],
                inProgress: false,
                isRadarVisible: false,
                __interval: null,
                __pointerX: null,
                __pointerY: null,
                __selectedA: null,
                __displayM: "all",
                __displayO: "both",
                __factor: null,
                __hitCanvas: null,
                __hitCtx: null,
                __poiHitMap: null,
                __layoutCacheCanvas: null,
                __layoutCacheScale: null,
                __layoutCacheCtx: null,

                /*
                 * Populate the left-side hover information panel.
                 *
                 * Stability note: earlier stages during the process the panel widths were fixed so long POI text no longer resizes
                 * the layout during hover. That layout shift was the real cause of POI "twitching".
                 */
                __setInfo: function (base) {
                    try {
                        var info = this.info;
                        info.removeAll();
                        if (!base) return;
                        for (var i = 0; i < base.length; i++) {
                            var title = new qx.ui.basic.Label(base[i][0]).set({
                                font: "font_size_13_bold",
                                textColor: "#FFFFFF",
                                width: 180,
                                minWidth: 180,
                                maxWidth: 180,
                                wrap: true
                            });
                            var value = new qx.ui.basic.Label(base[i][1]).set({
                                font: "font_size_11",
                                textColor: "#FFFFFF",
                                marginBottom: 5,
                                width: 180,
                                minWidth: 180,
                                maxWidth: 180,
                                wrap: true
                            });
                            info.add(title);
                            info.add(value);
                        }
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                __updatePoiSummary: function () {
                    var map = cdccta_map.getInstance();
                    var labels = [];
                    for (var t in map.__poiTypes) {
                        if (map.isPoiTypeVisible(parseInt(t, 10))) labels.push(map.__poiTypes[t].short);
                    }

                    var total = (map.__allMapPois && map.__allMapPois.length) ? map.__allMapPois.length : 0;
                    var mode = map.isAllPoiMode() ? " <span style='color:#8ce9ef'>(all)</span>" : "";

                    this.poiSummary.setValue(
                        "<b>POIs:</b> " + (labels.length ? labels.join(", ") : "none") +
                        "<br/><b>Cached:</b> " + total + mode
                    );
                },

                __updateAllPoiButton: function () {
                    var map = cdccta_map.getInstance();
                    if (!this.allPoiBtn) return;
                    this.allPoiBtn.setLabel(map.isAllPoiMode() ? "All POI: On" : "All POI: Off");
                },

                /*
                 * Create the radar background, hubs/fortress markers, and all currently selected overlays.
                 */
                __renderLayoutToContext: function (ctx, s) {
                    var circles = this.circles;
                    for (var i = 0; i < circles.length; i++) {
                        var r = circles[i];
                        ctx.beginPath();
                        ctx.arc(250, 250, r, 0, Math.PI * 2, true);
                        ctx.lineWidth = (i === 4) ? 1 / s : 0.3 / s;
                        ctx.strokeStyle = "#8ce9ef";
                        ctx.stroke();
                        ctx.closePath();
                    }

                    for (var j = 0; j < 8; j++) {
                        var r2 = circles[4],
                            a = (Math.PI * j / 4) - Math.PI / 8;
                        ctx.beginPath();
                        ctx.moveTo(250, 250);
                        ctx.lineTo((r2 * Math.cos(a)) + 250, (r2 * Math.sin(a)) + 250);
                        ctx.lineWidth = 0.3 / s;
                        ctx.strokeStyle = "#8ce9ef";
                        ctx.stroke();
                        ctx.closePath();
                    }

                    var endGame = cdccta_map.getInstance().__endGame,
                        hubs = endGame.hubs || [],
                        fortress = endGame.fortress || [250, 250];
                    var fortressX = fortress[0];
                    var fortressY = fortress[1];

                    var grd = ctx.createLinearGradient(fortressX, fortressY - 0.5, fortressX, fortressY + 0.5);
                    grd.addColorStop(0, "rgba(200, 228, 228, 0.5)");
                    grd.addColorStop(1, "rgba(170, 214, 118, 0.5)");
                    ctx.beginPath();
                    ctx.arc(fortressX - 0.2, fortressY - 0.2, 1, 0, Math.PI * 2, true);
                    ctx.fillStyle = grd;
                    ctx.lineWidth = 0.1;
                    ctx.strokeStyle = "#a5fe6a";
                    ctx.fill();
                    ctx.stroke();
                    ctx.closePath();

                    for (var k = 0; k < hubs.length; k++) {
                        var c = "rgba(200, 228, 228, 0.5)",
                            d = "rgba(170, 214, 118, 0.5)",
                            l = 1.3,
                            b = 0.1;
                        var x = hubs[k][0];
                        var y = hubs[k][1];
                        var grd2 = ctx.createLinearGradient(x, y, x, y + l);
                        grd2.addColorStop(0, c);
                        grd2.addColorStop(1, d);
                        ctx.beginPath();
                        ctx.rect(x - b, y - b, l, l);
                        ctx.fillStyle = grd2;
                        ctx.fill();
                        ctx.strokeStyle = "#a5fe6a";
                        ctx.lineWidth = b;
                        ctx.stroke();
                        ctx.closePath();
                    }
                },

                __createLayout: function () {
                    var s = this.scale,
                        ctx = this.ctx,
                        cacheCanvas = this.__layoutCacheCanvas,
                        cacheCtx = this.__layoutCacheCtx;

                    if (!cacheCanvas) {
                        cacheCanvas = document.createElement("canvas");
                        cacheCtx = cacheCanvas.getContext("2d");
                        this.__layoutCacheCanvas = cacheCanvas;
                        this.__layoutCacheCtx = cacheCtx;
                    }

                    if (this.__layoutCacheScale !== s || cacheCanvas.width !== this.canvas.width || cacheCanvas.height !== this.canvas.height) {
                        cacheCanvas.width = this.canvas.width;
                        cacheCanvas.height = this.canvas.height;
                        cacheCtx.setTransform(1, 0, 0, 1, 0, 0);
                        cacheCtx.clearRect(0, 0, cacheCanvas.width, cacheCanvas.height);
                        cacheCtx.scale(s, s);
                        this.__renderLayoutToContext(cacheCtx, s);
                        this.__layoutCacheScale = s;
                    }

                    ctx.drawImage(cacheCanvas, 0, 0);
                },

                /*
                 * Draw all bases for one alliance/relation bucket and record base metadata for hover info.
                 */
                __createAlliance: function (name, data, type, color) {
                    try {
                        this.inProgress = true;
                        var colors = {
                            "bases": {
                                "alliance": [["#86d3fb", "#75b7d9"]],
                                "owner": [["#ffc48b", "#d5a677"]],
                                "enemy": [["#ff8e8b", "#dc7a78"], ["#e25050", "#cc2d2d"], ["#93b7f8", "#527ef2"], ["#d389aa", "#b14e69"]],
                                "nap": [["#ffffff", "#cccccc"]],
                                "selected": [["#ffe50e", "#d7c109"]],
                                "ally": [["#6ce272", "#5fc664"], ["#d4e17e", "#b3ca47"], ["#92f8f2", "#52f2e8"], ["#1cba1c", "#108510"]]
                            }
                        };

                        var owner = ClientLib.Data.MainData.GetInstance().get_Player().get_Name(),
                            ctx = this.ctx,
                            factor = this.__factor;
                        var dop = this.__displayO,
                            dmd = this.__displayM,
                            s = this.scale;

                        var r = (s < 3) ? 0.65 : (s > 3) ? 0.35 : 0.5;

                        var createBase = function (x, y, bt, clr) {
                            var c = colors.bases[bt][clr][0],
                                d = colors.bases[bt][clr][1];
                            var grd = ctx.createLinearGradient(x, y - r, x, y + r);
                            grd.addColorStop(0, c);
                            grd.addColorStop(1, d);
                            ctx.beginPath();
                            ctx.arc(x, y, r, 0, Math.PI * 2, true);
                            ctx.closePath();
                            ctx.fillStyle = grd;
                            ctx.fill();
                            ctx.lineWidth = 0.1;
                            ctx.strokeStyle = "#000000";
                            ctx.stroke();
                            ctx.closePath();
                        };

                        if (dop !== "pois") {
                            for (var player in data.players) {
                                for (var i = 0; i < data.players[player].bases.length; i++) {
                                    var b = data.players[player].bases[i],
                                        pid = data.players[player].id;
                                    if (dmd === "bases") {
                                        if (player === owner) {
                                            this.elements.push({
                                                "x": b[0],
                                                "y": b[1],
                                                "wx": Math.round(b[0] / factor),
                                                "wy": Math.round(b[1] / factor),
                                                "an": name,
                                                "pn": player,
                                                "bn": b[2],
                                                "bi": b[3],
                                                "ai": data.id,
                                                "pi": pid,
                                                "type": "base"
                                            });
                                            this.locations.push([Math.round(b[0] / factor), Math.round(b[1] / factor)]);
                                            createBase(b[0], b[1], "owner", 0);
                                        }
                                    } else {
                                        this.elements.push({
                                            "x": b[0],
                                            "y": b[1],
                                            "wx": Math.round(b[0] / factor),
                                            "wy": Math.round(b[1] / factor),
                                            "an": name,
                                            "pn": player,
                                            "bn": b[2],
                                            "bi": b[3],
                                            "ai": data.id,
                                            "pi": pid,
                                            "type": "base"
                                        });
                                        this.locations.push([Math.round(b[0] / factor), Math.round(b[1] / factor)]);
                                        (player === owner) ? createBase(b[0], b[1], "owner", 0) : createBase(b[0], b[1], type, color);
                                    }
                                }
                            }
                        }
                        this.inProgress = false;
                    } catch (e) {
                        console.log(e.toString());
                    }
                },


                __drawCrystalCluster: function (ctx, size) {
                    var s = size;

                    ctx.beginPath();
                    ctx.moveTo(-s * 0.95, -s * 0.45);
                    ctx.lineTo(-s * 0.55, -s * 0.95);
                    ctx.lineTo(s * 0.55, -s * 0.95);
                    ctx.lineTo(s * 0.95, -s * 0.45);
                    ctx.lineTo(0, s * 1.00);
                    ctx.closePath();

                    ctx.fill();
                },

                __drawShield: function (ctx, size) {
                    ctx.beginPath();
                    ctx.moveTo(0, -size * 1.02);
                    ctx.lineTo(size * 0.84, -size * 0.54);
                    ctx.lineTo(size * 0.82, size * 0.06);
                    ctx.quadraticCurveTo(size * 0.82, size * 0.72, 0, size * 1.18);
                    ctx.quadraticCurveTo(-size * 0.82, size * 0.72, -size * 0.82, size * 0.06);
                    ctx.lineTo(-size * 0.84, -size * 0.54);
                    ctx.closePath();
                    ctx.fill();
                },

                __drawJet: function (ctx, size) {
                    ctx.beginPath();
                    ctx.moveTo(0, -size * 1.22);
                    ctx.lineTo(size * 0.12, -size * 0.82);
                    ctx.lineTo(size * 0.88, -size * 0.08);
                    ctx.lineTo(size * 0.88, size * 0.56);
                    ctx.lineTo(size * 0.24, size * 0.28);
                    ctx.lineTo(size * 0.2, size * 0.98);
                    ctx.lineTo(0, size * 0.76);
                    ctx.lineTo(-size * 0.2, size * 0.98);
                    ctx.lineTo(-size * 0.24, size * 0.28);
                    ctx.lineTo(-size * 0.88, size * 0.56);
                    ctx.lineTo(-size * 0.88, -size * 0.08);
                    ctx.lineTo(-size * 0.12, -size * 0.82);
                    ctx.closePath();
                    ctx.fill();

                    ctx.save();
                    ctx.globalCompositeOperation = "destination-out";
                    ctx.beginPath();
                    ctx.ellipse(0, -size * 0.54, size * 0.12, size * 0.2, 0, 0, Math.PI * 2, true);
                    ctx.fill();
                    ctx.restore();
                },

                __drawTank: function (ctx, size) {
                    var sy = size * 1.35;
                    ctx.beginPath();
                    ctx.moveTo(-size * 1.02, sy * 0.42);
                    ctx.lineTo(size * 0.84, sy * 0.42);
                    ctx.lineTo(size * 0.98, sy * 0.18);
                    ctx.lineTo(size * 0.96, -sy * 0.14);
                    ctx.lineTo(size * 0.86, -sy * 0.22);
                    ctx.lineTo(size * 0.24, -sy * 0.22);
                    ctx.lineTo(size * 0.18, -sy * 0.36);
                    ctx.lineTo(-size * 0.1, -sy * 0.52);
                    ctx.lineTo(-size * 0.42, -sy * 0.46);
                    ctx.lineTo(-size * 0.6, -sy * 0.34);
                    ctx.lineTo(-size * 0.86, -sy * 0.34);
                    ctx.lineTo(-size * 1.02, -sy * 0.18);
                    ctx.lineTo(-size * 1.02, -sy * 0.02);
                    ctx.lineTo(-size * 0.9, -sy * 0.02);
                    ctx.lineTo(-size * 0.9, sy * 0.12);
                    ctx.lineTo(-size * 1.12, sy * 0.12);
                    ctx.lineTo(-size * 1.12, sy * 0.24);
                    ctx.lineTo(-size * 1.02, sy * 0.24);
                    ctx.closePath();
                    ctx.fill();

                    ctx.beginPath();
                    ctx.rect(size * 0.12, -sy * 0.28, size * 1.16, sy * 0.12);
                    ctx.fill();
                },

                __drawInfantry: function (ctx, size) {
                    ctx.beginPath();
                    ctx.arc(0, -size * 0.9, size * 0.24, 0, Math.PI * 2, true);
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(-size * 0.08, -size * 0.64);
                    ctx.lineTo(size * 0.18, -size * 0.64);
                    ctx.lineTo(size * 0.64, size * 0.08);
                    ctx.lineTo(size * 0.46, size * 0.2);
                    ctx.lineTo(size * 0.12, -size * 0.18);
                    ctx.lineTo(size * 0.1, size * 1.02);
                    ctx.lineTo(-size * 0.16, size * 1.02);
                    ctx.lineTo(-size * 0.22, size * 0.12);
                    ctx.lineTo(-size * 0.5, size * 1.12);
                    ctx.lineTo(-size * 0.74, size * 1.08);
                    ctx.lineTo(-size * 0.4, -size * 0.08);
                    ctx.lineTo(-size * 0.72, -size * 0.18);
                    ctx.lineTo(-size * 0.62, -size * 0.48);
                    ctx.closePath();
                    ctx.fill();

                    ctx.beginPath();
                    ctx.moveTo(-size * 0.62, -size * 0.32);
                    ctx.lineTo(size * 0.18, -size * 0.02);
                    ctx.lineTo(size * 0.88, size * 0.48);
                    ctx.lineTo(size * 0.82, size * 0.58);
                    ctx.lineTo(size * 0.08, size * 0.18);
                    ctx.lineTo(-size * 0.48, -size * 0.02);
                    ctx.closePath();
                    ctx.fill();
                },

                __drawLightning: function (ctx, size) {
                    ctx.beginPath();
                    ctx.moveTo(size * 0.02, -size * 1.16);
                    ctx.lineTo(-size * 0.26, -size * 0.3);
                    ctx.lineTo(size * 0.02, -size * 0.3);
                    ctx.lineTo(-size * 0.16, size * 1.1);
                    ctx.lineTo(size * 0.26, size * 0.1);
                    ctx.lineTo(0, size * 0.1);
                    ctx.lineTo(size * 0.24, -size * 1.16);
                    ctx.closePath();
                    ctx.fill();
                },

                __drawReactor: function (ctx, size) {
                    ctx.save();
                    ctx.lineWidth = Math.max(0.22, size * 0.18);
                    ctx.lineCap = "round";
                    ctx.beginPath();
                    ctx.arc(0, 0, size * 0.92, Math.PI * 0.22, Math.PI * 1.78, false);
                    ctx.stroke();
                    ctx.beginPath();
                    ctx.arc(0, 0, size * 0.92, -Math.PI * 0.78, Math.PI * 0.78, false);
                    ctx.stroke();
                    ctx.restore();

                    ctx.save();
                    ctx.scale(3.10, 1);   // widen bolt only
                    this.__drawLightning(ctx, size * 0.84);
                    ctx.restore();
                },

                __drawPoiIcon: function (x, y, type, level) {
                    var ctx = this.ctx;
                    var s = this.scale;

                    var size =
                        (s <= 1) ? 1.26 :
                    (s <= 3) ? 1.38 :
                    (s <= 7) ? 1.54 :
                    1.70;

                    var iconColors = {
                        2: "#11bf16",
                        3: "#29a5ff",
                        4: "#1d27f0",
                        5: "#e85a0c",
                        6: "#9230c8",
                        7: "#e7df00",
                        8: "#ec55b2"
                    };

                    var textColors = {
                        2: "#ffffff",
                        3: "#ffffff",
                        4: "#ffffff",
                        5: "#ffffff",
                        6: "#ffffff",
                        7: "#3d3200",
                        8: "#ffffff"
                    };

                    var textStrokeColors = {
                        2: "rgba(0,0,0,0.85)",
                        3: "rgba(0,0,0,0.85)",
                        4: "rgba(0,0,0,0.85)",
                        5: "rgba(0,0,0,0.85)",
                        6: "rgba(0,0,0,0.85)",
                        7: "rgba(255,255,255,0.95)",
                        8: "rgba(0,0,0,0.85)"
                    };

                    var textOffsets = {
                        2: size * 0.04,
                        3: size * 0.04,
                        4: 0,
                        5: size * 0.05,
                        6: size * 0.01,
                        7: size * 0.02,
                        8: size * 0.02
                    };

                    ctx.save();
                    ctx.translate(x, y);
                    ctx.fillStyle = iconColors[type] || "#aaaaaa";
                    ctx.strokeStyle = iconColors[type] || "#aaaaaa";
                    ctx.lineJoin = "round";
                    ctx.lineCap = "round";

                    switch (type) {
                        case 2:
                        case 3:
                            this.__drawCrystalCluster(ctx, size * 0.82);
                            break;
                        case 4:
                            this.__drawReactor(ctx, size * 0.84);
                            break;
                        case 5:
                            this.__drawInfantry(ctx, size * 0.86);
                            break;
                        case 6:
                            this.__drawTank(ctx, size * 0.84);
                            break;
                        case 7:
                            this.__drawJet(ctx, size * 0.88);
                            break;
                        case 8:
                            this.__drawShield(ctx, size * 0.88);
                            break;
                        default:
                            ctx.beginPath();
                            ctx.arc(0, 0, size * 0.8, 0, Math.PI * 2, true);
                            ctx.fill();
                            break;
                    }

                    if (level != null && level !== "") {
                        ctx.save();
                        ctx.fillStyle = textColors[type] || "#ffffff";
                        ctx.strokeStyle = textStrokeColors[type] || "rgba(0,0,0,0.85)";
                        ctx.lineWidth = Math.max(0.10, size * 0.055);
                        ctx.font = "bold " + Math.max(1.05, size * 0.40) + "px Arial";
                        ctx.textAlign = "center";
                        ctx.textBaseline = "middle";
                        ctx.strokeText(String(level), 0, textOffsets[type] || 0);
                        ctx.fillText(String(level), 0, textOffsets[type] || 0);
                        ctx.restore();
                    }

                    ctx.restore();
                },


                __encodeHitColor: function (id) {
                    return "rgb(" + (id & 255) + "," + ((id >> 8) & 255) + "," + ((id >> 16) & 255) + ")";
                },

                __decodeHitId: function (rgba) {
                    if (!rgba || rgba.length < 4 || rgba[3] === 0) return 0;
                    return rgba[0] + (rgba[1] << 8) + (rgba[2] << 16);
                },

                __drawPoiHitIcon: function (x, y, type, id) {
                    var ctx = this.__hitCtx;
                    if (!ctx || !id) return;

                    var size = this.__getPoiIconSize();
                    var color = this.__encodeHitColor(id);

                    ctx.save();
                    ctx.translate(x, y);
                    ctx.fillStyle = color;
                    ctx.strokeStyle = color;
                    ctx.lineJoin = "round";
                    ctx.lineCap = "round";

                    switch (type) {
                        case 2:
                        case 3:
                            this.__drawCrystalCluster(ctx, size * 0.82);
                            break;
                        case 4:
                            ctx.lineWidth = Math.max(0.22, size * 0.84 * 0.18);
                            this.__drawReactor(ctx, size * 0.84);
                            break;
                        case 5:
                            this.__drawInfantry(ctx, size * 0.86);
                            break;
                        case 6:
                            this.__drawTank(ctx, size * 0.84);
                            break;
                        case 7:
                            this.__drawJet(ctx, size * 0.88);
                            break;
                        case 8:
                            this.__drawShield(ctx, size * 0.88);
                            break;
                        default:
                            ctx.beginPath();
                            ctx.arc(0, 0, size * 0.8, 0, Math.PI * 2, true);
                            ctx.fill();
                            break;
                    }

                    ctx.restore();
                },

                __findPoiElementAtMouseByPixel: function (event) {
                    var state = this.__getMouseMapState(event);
                    if (!state.insideRadar) return null;
                    if (!this.__hitCtx || !this.__poiHitMap) return null;

                    var px = Math.floor(state.cx);
                    var py = Math.floor(state.cy);

                    if (px < 0 || py < 0 || px >= this.__hitCanvas.width || py >= this.__hitCanvas.height) {
                        return null;
                    }

                    var rgba = this.__hitCtx.getImageData(px, py, 1, 1).data;
                    var id = this.__decodeHitId(rgba);
                    return id ? (this.__poiHitMap[id] || null) : null;
                },

                /*
                 * Draw cached valid POIs onto the custom radar canvas and register them for hover/click info.
                 */
                __createGlobalPois: function () {
                    try {
                        var map = cdccta_map.getInstance();
                        var pois = map.__allMapPois || [];

                        for (var i = 0; i < pois.length; i++) {
                            var poi = pois[i];
                            if (!map.isPoiTypeVisible(poi.t)) continue;

                            this.__drawPoiIcon(poi.x, poi.y, poi.t, poi.l);

                            var el = {
                                "x": poi.x,
                                "y": poi.y,
                                "wx": poi.wx,
                                "wy": poi.wy,
                                "an": poi.ownerAllianceName || "POI",
                                "t": poi.t,
                                "l": poi.l,
                                "tn": map.getPoiTypeLabel(poi.t),
                                "type": "poi"
                            };

                            this.elements.push(el);
                            this.locations.push([Math.round(poi.wx), Math.round(poi.wy)]);

                            var hitId = this.elements.length;
                            this.__poiHitMap[hitId] = el;
                            this.__drawPoiHitIcon(poi.x, poi.y, poi.t, hitId);
                        }
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                __getMouseMapState: function (event) {
                    var canvas = this.canvas;
                    var rect = canvas.getBoundingClientRect();

                    var clientX = (typeof event.clientX !== "undefined") ? event.clientX : (event.pageX - window.pageXOffset);
                    var clientY = (typeof event.clientY !== "undefined") ? event.clientY : (event.pageY - window.pageYOffset);

                    var cx = clientX - rect.left;
                    var cy = clientY - rect.top;

                    var logicalX = cx / this.scale;
                    var logicalY = cy / this.scale;

                    var worldX = Math.round(cx / (this.scale * this.__factor));
                    var worldY = Math.round(cy / (this.scale * this.__factor));

                    var screenX = cx + canvas.offsetLeft;
                    var screenY = cy + canvas.offsetTop;
                    var insideRadar = Math.sqrt(Math.pow(screenX - 250, 2) + Math.pow(screenY - 250, 2)) <= 242;

                    return {
                        cx: cx,
                        cy: cy,
                        logicalX: logicalX,
                        logicalY: logicalY,
                        worldX: worldX,
                        worldY: worldY,
                        screenX: screenX,
                        screenY: screenY,
                        insideRadar: insideRadar
                    };
                },

                /*
                 * Exact tile hit-test used by the existing click/hover logic.
                 * This remains behaviorally unchanged in the stable release.
                 */
                __findElementAtMouse: function (event) {
                    var state = this.__getMouseMapState(event);
                    if (!state.insideRadar) return null;

                    var elements = this.elements || [];
                    var locations = this.locations || [];
                    var x = state.worldX;
                    var y = state.worldY;

                    for (var i = 0; i < locations.length; i++) {
                        if (x === locations[i][0] && y === locations[i][1]) {
                            return elements[i];
                        }
                    }

                    return null;
                },

                __getPoiIconSize: function () {
                    var s = this.scale;
                    return (s <= 1) ? 1.26 : (s <= 3) ? 1.38 : (s <= 7) ? 1.54 : 1.70;
                },

                __pointInPolygon: function (px, py, points) {
                    var inside = false;
                    for (var i = 0, j = points.length - 1; i < points.length; j = i++) {
                        var xi = points[i][0], yi = points[i][1];
                        var xj = points[j][0], yj = points[j][1];
                        var intersect = ((yi > py) !== (yj > py)) &&
                            (px < (xj - xi) * (py - yi) / ((yj - yi) || 1e-9) + xi);
                        if (intersect) inside = !inside;
                    }
                    return inside;
                },

                __pointSegmentDistanceSq: function (px, py, x1, y1, x2, y2) {
                    var dx = x2 - x1, dy = y2 - y1;
                    if (dx === 0 && dy === 0) {
                        dx = px - x1;
                        dy = py - y1;
                        return dx * dx + dy * dy;
                    }
                    var t = ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy);
                    t = Math.max(0, Math.min(1, t));
                    var cx = x1 + t * dx;
                    var cy = y1 + t * dy;
                    dx = px - cx;
                    dy = py - cy;
                    return dx * dx + dy * dy;
                },

                __isPointOnStrokePolyline: function (px, py, points, halfWidth, closed) {
                    var maxSq = halfWidth * halfWidth;
                    for (var i = 0; i < points.length - 1; i++) {
                        if (this.__pointSegmentDistanceSq(px, py, points[i][0], points[i][1], points[i + 1][0], points[i + 1][1]) <= maxSq) return true;
                    }
                    if (closed && points.length > 2) {
                        return this.__pointSegmentDistanceSq(px, py, points[points.length - 1][0], points[points.length - 1][1], points[0][0], points[0][1]) <= maxSq;
                    }
                    return false;
                },

                __isPointInEllipse: function (px, py, cx, cy, rx, ry) {
                    var nx = (px - cx) / rx;
                    var ny = (py - cy) / ry;
                    return (nx * nx + ny * ny) <= 1;
                },

                __normalizeAngle: function (a) {
                    while (a < 0) a += Math.PI * 2;
                    while (a >= Math.PI * 2) a -= Math.PI * 2;
                    return a;
                },

                __isAngleBetween: function (angle, start, end) {
                    angle = this.__normalizeAngle(angle);
                    start = this.__normalizeAngle(start);
                    end = this.__normalizeAngle(end);
                    if (start <= end) return angle >= start && angle <= end;
                    return angle >= start || angle <= end;
                },

                __isPointOnArcStroke: function (px, py, radius, start, end, halfWidth) {
                    var dist = Math.sqrt(px * px + py * py);
                    if (Math.abs(dist - radius) > halfWidth) return false;
                    return this.__isAngleBetween(Math.atan2(py, px), start, end);
                },

                __isPointOnPoiVisual: function (el, px, py) {
                    var size = this.__getPoiIconSize();
                    var x = px - el.x;
                    var y = py - el.y;
                    var s, pts;

                    switch (el.t) {
                        case 2:
                        case 3:
                            s = size * 0.82;
                            pts = [
                                [-s * 0.95, -s * 0.45],
                                [-s * 0.55, -s * 0.95],
                                [s * 0.55, -s * 0.95],
                                [s * 0.95, -s * 0.45],
                                [0, s * 1.00]
                            ];
                            return this.__pointInPolygon(x, y, pts);
                        case 4:
                            s = size * 0.84;
                            var lineWidth = Math.max(0.22, s * 0.18) * 0.5 + 0.10;
                            if (this.__isPointOnArcStroke(x, y, s * 0.92, Math.PI * 0.22, Math.PI * 1.78, lineWidth)) return true;
                            if (this.__isPointOnArcStroke(x, y, s * 0.92, -Math.PI * 0.78, Math.PI * 0.78, lineWidth)) return true;
                            pts = [
                                [3.10 * (s * 0.02), -s * 1.16],
                                [3.10 * (-s * 0.26), -s * 0.3],
                                [3.10 * (s * 0.02), -s * 0.3],
                                [3.10 * (-s * 0.16), s * 1.1],
                                [3.10 * (s * 0.26), s * 0.1],
                                [0, s * 0.1],
                                [3.10 * (s * 0.24), -s * 1.16]
                            ];
                            return this.__pointInPolygon(x, y, pts);
                        case 5:
                            s = size * 0.86;
                            if (this.__isPointInEllipse(x, y, 0, -s * 0.9, s * 0.24, s * 0.24)) return true;
                            pts = [
                                [-s * 0.08, -s * 0.64], [s * 0.18, -s * 0.64], [s * 0.64, s * 0.08],
                                [s * 0.46, s * 0.2], [s * 0.12, -s * 0.18], [s * 0.1, s * 1.02],
                                [-s * 0.16, s * 1.02], [-s * 0.22, s * 0.12], [-s * 0.5, s * 1.12],
                                [-s * 0.74, s * 1.08], [-s * 0.4, -s * 0.08], [-s * 0.72, -s * 0.18],
                                [-s * 0.62, -s * 0.48]
                            ];
                            if (this.__pointInPolygon(x, y, pts)) return true;
                            pts = [
                                [-s * 0.62, -s * 0.32], [s * 0.18, -s * 0.02], [s * 0.88, s * 0.48],
                                [s * 0.82, s * 0.58], [s * 0.08, s * 0.18], [-s * 0.48, -s * 0.02]
                            ];
                            return this.__pointInPolygon(x, y, pts);
                        case 6:
                            s = size * 0.84;
                            var sy = s * 1.35;
                            pts = [
                                [-s * 1.02, sy * 0.42], [s * 0.84, sy * 0.42], [s * 0.98, sy * 0.18],
                                [s * 0.96, -sy * 0.14], [s * 0.86, -sy * 0.22], [s * 0.24, -sy * 0.22],
                                [s * 0.18, -sy * 0.36], [-s * 0.1, -sy * 0.52], [-s * 0.42, -sy * 0.46],
                                [-s * 0.6, -sy * 0.34], [-s * 0.86, -sy * 0.34], [-s * 1.02, -sy * 0.18],
                                [-s * 1.02, -sy * 0.02], [-s * 0.9, -sy * 0.02], [-s * 0.9, sy * 0.12],
                                [-s * 1.12, sy * 0.12], [-s * 1.12, sy * 0.24], [-s * 1.02, sy * 0.24]
                            ];
                            if (this.__pointInPolygon(x, y, pts)) return true;
                            return (x >= s * 0.12 && x <= s * 1.28 && y >= -sy * 0.28 && y <= -sy * 0.16);
                        case 7:
                            s = size * 0.88;
                            pts = [
                                [0, -s * 1.22], [s * 0.12, -s * 0.82], [s * 0.88, -s * 0.08],
                                [s * 0.88, s * 0.56], [s * 0.24, s * 0.28], [s * 0.2, s * 0.98],
                                [0, s * 0.76], [-s * 0.2, s * 0.98], [-s * 0.24, s * 0.28],
                                [-s * 0.88, s * 0.56], [-s * 0.88, -s * 0.08], [-s * 0.12, -s * 0.82]
                            ];
                            return this.__pointInPolygon(x, y, pts);
                        case 8:
                            s = size * 0.88;
                            pts = [
                                [0, -s * 1.02], [s * 0.84, -s * 0.54], [s * 0.82, s * 0.06],
                                [s * 0.62, s * 0.62], [0, s * 1.18], [-s * 0.62, s * 0.62],
                                [-s * 0.82, s * 0.06], [-s * 0.84, -s * 0.54]
                            ];
                            return this.__pointInPolygon(x, y, pts);
                        default:
                            return this.__isPointInEllipse(x, y, 0, 0, size * 0.8, size * 0.8);
                    }
                },

                __findHoverElementAtMouse: function (event) {
                    var poiHit = this.__findPoiElementAtMouseByPixel(event);
                    if (poiHit) return poiHit;
                    return this.__findElementAtMouse(event);
                },

                /*
                 * Wire drag, hover, and click handlers for the radar.
                 * Dragging moves the zoomed canvas; hover updates the info panel; clicks center the game view.
                 */
                __draggable: function (mask) {
                    try {
                        var start, end, initCoords = [], selectedBase = false, root = this, canvas = this.canvas, c = 0;
                        var factor = root.__factor;

                        var displayBaseInfo = function () {
                            try {
                                if (!selectedBase || root.inProgress) return;
                                var base = [];
                                for (var i in selectedBase) {
                                    var txt = "", val = "";
                                    switch (i) {
                                        case "an":
                                            txt = "Alliance:";
                                            val = selectedBase[i];
                                            break;
                                        case "bn":
                                            txt = "Base    :";
                                            val = selectedBase[i];
                                            break;
                                        case "pn":
                                            txt = "Player  :";
                                            val = selectedBase[i];
                                            break;
                                        case "l":
                                            txt = "Level   :";
                                            val = selectedBase[i];
                                            break;
                                        case "tn":
                                            txt = "POI Type :";
                                            val = selectedBase[i];
                                            break;
                                        default:
                                            txt = false;
                                    }
                                    if (txt) base.push([txt, String(val)]);
                                }
                                root.__setInfo(base);
                            } catch (e) {
                                console.log(e.toString());
                            }
                        };

                        var onMapHover = function (event) {
                            var coordsField = root.coordsField;
                            var state = root.__getMouseMapState(event);

                            if (!state.insideRadar) {
                                coordsField.setValue("");
                                selectedBase = false;
                                root.__setInfo(false);
                                return;
                            }

                            root.__pointerX = state.worldX;
                            root.__pointerY = state.worldY;
                            coordsField.setValue(state.worldX + ":" + state.worldY);

                            if (root.scale < 2 || root.inProgress) return;

                            var hit = root.__findHoverElementAtMouse(event);
                            if (hit) {
                                selectedBase = hit;
                                displayBaseInfo();
                                return;
                            }

                            selectedBase = false;
                            root.__setInfo(false);
                        };

                        var onMapDrag = function (event) {
                            if (root.scale === 1 || root.inProgress) return;
                            var canvasX = canvas.offsetLeft,
                                canvasY = canvas.offsetTop,
                                mouseX = event.pageX,
                                mouseY = event.pageY;
                            var newX = canvasX + mouseX - initCoords[0],
                                newY = canvasY + mouseY - initCoords[1];
                            initCoords[0] = mouseX;
                            initCoords[1] = mouseY;
                            canvas.style.top = newY + "px";
                            canvas.style.left = newX + "px";
                        };

                        var onMapWheel = function (event) {
                            if (root.inProgress) return;
                            var delta = Math.max(-1, Math.min(1, (event.wheelDelta || -event.detail)));
                            if ((delta < 0 && root.scale <= 1) || (delta > 0 && root.scale >= 12)) return;
                            c += delta;
                            var str = (Math.abs(c) % 3 === 0) ? ((delta < 0) ? "down" : "up") : false;
                            if (str) root.__scaleMap(str);
                        };

                        var onMapDown = function (event) {
                            initCoords = [event.pageX, event.pageY];
                            start = (new Date()).getTime();
                            mask.removeEventListener("mousemove", onMapHover, false);
                            mask.addEventListener("mousemove", onMapDrag, false);
                        };

                        var onMapUp = function (event) {
                            end = (new Date()).getTime();
                            mask.removeEventListener("mousemove", onMapDrag, false);
                            mask.addEventListener("mousemove", onMapHover, false);
                            if (end - start < 150) {
                                var hit = root.__findElementAtMouse(event);
                                var state = root.__getMouseMapState(event);

                                var targetX = hit ? hit.wx : state.worldX;
                                var targetY = hit ? hit.wy : state.worldY;

                                root.__pointerX = targetX;
                                root.__pointerY = targetY;

                                webfrontend.gui.UtilView.centerCoordinatesOnRegionViewWindow(targetX, targetY);
                                cdccta_map.getInstance().__beginPoiRescanAfterMapClick();
                            }
                        };

                        var onMapOut = function () {
                            mask.removeEventListener("mousemove", onMapDrag, false);
                            mask.addEventListener("mousemove", onMapHover, false);
                        };

                        mask.addEventListener("mouseup", onMapUp, false);
                        mask.addEventListener("mousedown", onMapDown, false);
                        mask.addEventListener("mousemove", onMapHover, false);
                        mask.addEventListener("mouseout", onMapOut, false);
                        mask.addEventListener("mousewheel", onMapWheel, false);
                        mask.addEventListener("DOMMouseScroll", onMapWheel, false);
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                __startRadarScan: function () {
                    this.isRadarVisible = true;
                    var FRAMES_PER_CYCLE = 20,
                        FRAMERATE = 20,
                        RINGS = 6;
                    var canvas = this.canvas,
                        ctx = this.ctx,
                        canvassize = 400,
                        animationframe = 0,
                        root = this;
                    var ringsize = canvassize / (2 * RINGS + 1);
                    var radiusmax = ringsize / 2 + ringsize + (RINGS - 1) * ringsize;

                    function animateRadarFrame() {
                        ctx.clearRect(0, 0, canvas.width, canvas.height);
                        root.__createLayout();
                        for (var ringno = 0; ringno < RINGS; ringno++) {
                            var radius = ringsize / 2 + (animationframe / FRAMES_PER_CYCLE) * ringsize + ringno * ringsize;
                            var alpha = (radiusmax - radius) / radiusmax;
                            ctx.beginPath();
                            ctx.fillStyle = "rgba(92,178,112," + alpha + ")";
                            ctx.arc(250, 250, radius, 0, 2 * Math.PI, false);
                            ctx.fill();
                            ctx.closePath();
                        }

                        ctx.beginPath();
                        ctx.fillStyle = "rgb(100,194,122)";
                        ctx.arc(250, 250, ringsize / 2, 0, 2 * Math.PI, false);
                        ctx.fill();
                        ctx.closePath();

                        animationframe = (animationframe >= (FRAMES_PER_CYCLE - 1)) ? 0 : animationframe + 1;
                    }
                    this.__interval = setInterval(animateRadarFrame, 1000 / FRAMERATE);
                },

                __stopRadarScan: function () {
                    if (!this.isRadarVisible) return;
                    clearInterval(this.__interval);
                    this.isRadarVisible = false;
                    this.__enablePanel();
                },

                __disablePanel: function () {
                    this.inProgress = true;
                    for (var i = 0; i < this.panel.length; i++) this.panel[i].setEnabled(false);
                },

                __enablePanel: function () {
                    this.inProgress = false;
                    for (var i = 0; i < this.panel.length; i++) this.panel[i].setEnabled(true);
                },

                __createIcon: function (color, width, height) {
                    var canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;

                    var ctx = canvas.getContext("2d");
                    ctx.beginPath();
                    ctx.rect(0, 0, width, height);
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.closePath();

                    return canvas.toDataURL("image/png");
                },

                __updateList: function () {
                    var dm = this.__displayM;
                    this.__selectedA = null;
                    this.allianceList.removeAll();
                    var d = this.receivedData,
                        root = this;
                    var colors = {
                        "enemy": ["#ff807d", "#a93939", "#739bf5", "#c26b89"],
                        "ally": ["#3bbe5d", "#c4d663", "#73f5ed", "#169f16"],
                        "nap": ["#ffffff"],
                        "selected": ["#ffe50e"],
                        "alliance": ["#75b7d9"],
                        "owner": ["#ffc48b"]
                    };
                    if (d) {
                        for (var i = 0; i < d.length; i++) {
                            var name = d[i][0].name,
                                type = d[i][1],
                                aid = d[i][0].id,
                                clr = d[i][2];
                            if ((dm === "all") || (dm === "selected")) {
                                var color = colors[type][clr];
                                var li = new qx.ui.form.ListItem(name, root.__createIcon(color, 10, 10), aid);
                                var tooltip = new qx.ui.tooltip.ToolTip(name + " - " + type, root.__createIcon(color, 15, 15));
                                li.setToolTip(tooltip);
                                this.allianceList.add(li);
                            } else if (type === "alliance") {
                                var color2 = colors[type][clr];
                                var li2 = new qx.ui.form.ListItem(name, root.__createIcon(color2, 10, 10), aid);
                                var tooltip2 = new qx.ui.tooltip.ToolTip(name + " - " + type, root.__createIcon(color2, 15, 15));
                                li2.setToolTip(tooltip2);
                                this.allianceList.add(li2);
                                break;
                            }
                        }
                    }
                    this.__updatePoiSummary();
                    this.__updateAllPoiButton();
                },

                /*
                 * Full canvas redraw.
                 * Reset drawing caches, resize the backing canvases, then paint bases/POIs/layout again.
                 */
                drawCanvas: function () {
                    var dmd = this.__displayM,
                        b = this.receivedData;
                    var selected = (this.__selectedA != null && typeof this.__selectedA === "number") ? this.__selectedA : false;
                    var n = this.scale,
                        canvas = this.canvas,
                        ctx = this.ctx;

                    this.elements = [];
                    this.locations = [];
                    this.__poiHitMap = {};
                    this.__stopRadarScan();
                    canvas.width = n * 500;
                    canvas.height = n * 500;

                    this.__hitCanvas.width = n * 500;
                    this.__hitCanvas.height = n * 500;
                    if (!this.__hitCtx) {
                        this.__hitCtx = this.__hitCanvas.getContext("2d", { willReadFrequently: true });
                    }

                    ctx = canvas.getContext("2d");
                    ctx.setTransform(1, 0, 0, 1, 0, 0);
                    ctx.scale(n, n);
                    this.ctx = ctx;

                    this.__hitCtx.setTransform(1, 0, 0, 1, 0, 0);
                    this.__hitCtx.clearRect(0, 0, this.__hitCanvas.width, this.__hitCanvas.height);
                    this.__hitCtx.scale(n, n);

                    this.__createLayout();

                    if (b) {
                        for (var i = 0; i < b.length; i++) {
                            var name = b[i][0].name,
                                data = b[i][0],
                                type = b[i][1],
                                aid = b[i][0].id,
                                color = b[i][2];
                            if (((dmd === "alliance") || (dmd === "bases")) && (type === "alliance")) {
                                this.__createAlliance(name, data, type, 0);
                                break;
                            }
                            if (dmd === "all") {
                                if (selected && (aid === selected)) {
                                    type = "selected";
                                    color = 0;
                                }
                                this.__createAlliance(name, data, type, color);
                            }
                            if ((dmd === "selected") && selected && (aid === selected)) {
                                this.__createAlliance(name, data, type, color);
                                break;
                            }
                        }
                    }

                    if (this.__displayO !== "bases") {
                        this.__createGlobalPois();
                    }
                },

                /*
                 * Zoom the custom canvas while preserving the current visual center.
                 */
                __scaleMap: function (str) {
                    try {
                        var newScale = (str === "up") ? this.scale + 2 : this.scale - 2;
                        if (newScale > 12 || newScale < 1 || this.inProgress) return;
                        var canvas = this.canvas;
                        var x = ((canvas.offsetLeft - 250) * newScale / this.scale) + 250,
                            y = ((canvas.offsetTop - 250) * newScale / this.scale) + 250;

                        this.scale = newScale;
                        switch (this.scale) {
                            case 1:
                                this.zoomOut.setEnabled(false);
                                this.zoomReset.setEnabled(false);
                                this.zoomIn.setEnabled(true);
                                break;
                            case 11:
                                this.zoomOut.setEnabled(true);
                                this.zoomReset.setEnabled(true);
                                this.zoomIn.setEnabled(false);
                                break;
                            default:
                                this.zoomOut.setEnabled(true);
                                this.zoomReset.setEnabled(true);
                                this.zoomIn.setEnabled(true);
                                break;
                        }
                        this.drawCanvas();
                        canvas.style.left = newScale === 1 ? 0 : x + "px";
                        canvas.style.top = newScale === 1 ? 0 : y + "px";
                    } catch (e) {
                        console.log(e.toString());
                    }
                },

                /*
                 * Return the radar view to scale 1, clear offsets, and start a fresh scan/draw cycle.
                 */
                resetMap: function () {
                    var canvas = this.canvas,
                        ctx = this.ctx;
                    this.scale = 1;
                    canvas.width = 500;
                    canvas.height = 500;
                    canvas.style.left = 0;
                    canvas.style.top = 0;
                    ctx.clearRect(0, 0, canvas.width, canvas.height);
                    this.__disablePanel();
                    this.__startRadarScan();
                },

                /*
                 * Open the map window and refresh UI elements that depend on current POI cache state.
                 */
                open: function () {
                    var app = qx.core.Init.getApplication();
                    var mainOverlay = app.getMainOverlay();

                    this.setWidth(mainOverlay.getWidth());
                    this.setMaxWidth(mainOverlay.getMaxWidth());
                    this.setHeight(mainOverlay.getHeight());
                    this.setMaxHeight(mainOverlay.getMaxHeight());

                    this.__updateAllPoiButton();
                    this.__updatePoiSummary();

                    app.getDesktop().add(this, {
                        left: mainOverlay.getBounds().left,
                        top: mainOverlay.getBounds().top
                    });
                },

                _onClose: function () {
                    var opt = cdccta_map.options.getInstance();
                    var poiopt = cdccta_map.poioptions.getInstance();
                    var poiexport = cdccta_map.poiexport.getInstance();
                    var app = qx.core.Init.getApplication();
                    app.getDesktop().remove(this);
                    if (opt.isSeeable()) opt.close();
                    if (poiopt.isSeeable()) poiopt.close();
                    if (poiexport.isSeeable()) poiexport.close();
                    cdccta_map.getInstance().__stopPoiWatcher();
                },

                _onResize: function () {
                    var windowWidth = window.innerWidth - 10;
                    var width = this.getWidth();
                    var offsetLeft = (windowWidth - width) / 2;

                    this.setDomLeft(offsetLeft);

                    var opt = cdccta_map.options.getInstance();
                    if (opt.isSeeable()) opt.setDomLeft(offsetLeft + width + 5);

                    var poiopt = cdccta_map.poioptions.getInstance();
                    if (poiopt.isSeeable()) poiopt.positionNextToMainWindow();

                    var poiexport = cdccta_map.poiexport.getInstance();
                    if (poiexport.isSeeable()) poiexport.positionNextToMainWindow();
                }
            }
        });

        qx.Class.define("cdccta_map.options", {
            type: "singleton",
            extend: webfrontend.gui.CustomWindow,

            /*
             * Entry point for the singleton.
             * Wait until world/endgame data is available, then initialize the script UI.
             */
            construct: function () {
                try {
                    this.base(arguments);
                    this.setLayout(new qx.ui.layout.VBox(10));
                    this.set({
                        width: 200,
                        height: 500,
                        showMinimize: true,
                        showMaximize: true,
                        alwaysOnTop: true,
                        caption: "Alliances Shown on Map"
                    });

                    this.__getAlliances();

                    var root = this;

                    var searchBox = new qx.ui.form.TextField().set({
                        placeholder: "Search..."
                    });
                    var list = new qx.ui.form.List().set({
                        height: 80
                    });
                    var editList = new qx.ui.form.List().set({
                        height: 160,
                        selectionMode: "additive"
                    });

                    var radioButtons = [
                        ["Enemy", "enemy"],
                        ["Ally", "ally"],
                        ["NAP", "nap"]
                    ];
                    var radioGroup = new qx.ui.form.RadioGroup().set({
                        allowEmptySelection: true
                    });
                    var radioGroupC = new qx.ui.container.Composite(new qx.ui.layout.HBox(10));
                    radioGroupC.setTextColor("#aaaaaa");
                    for (var i = 0; i < radioButtons.length; i++) {
                        var radioButton = new qx.ui.form.RadioButton(radioButtons[i][0]);
                        radioButton.setModel(radioButtons[i][1]);
                        radioButton.setGroup(radioGroup);
                        radioGroupC.add(radioButton);
                    }

                    var colors = root.__colors;
                    var colorSelectBox = new qx.ui.form.SelectBox().set({
                        height: 28
                    });
                    var addColors = function (type) {
                        colorSelectBox.removeAll();
                        for (var j = 0; j < colors[type].length; j++) {
                            var src = root.__createIcon(colors[type][j], 60, 15);
                            var listItem = new qx.ui.form.ListItem(null, src, j);
                            colorSelectBox.add(listItem);
                        }
                    };
                    addColors("enemy");

                    var addButton = new qx.ui.form.Button("Add").set({
                        enabled: false,
                        width: 85,
                        toolTipText: "Maximum allowed number of alliances is 8."
                    });
                    var removeButton = new qx.ui.form.Button("Remove").set({
                        enabled: false,
                        width: 85
                    });
                    var applyButton = new qx.ui.form.Button("Apply").set({
                        enabled: false
                    });
                    var defaultsButton = new qx.ui.form.Button("Defaults").set({
                        enabled: false,
                        width: 85
                    });
                    var saveButton = new qx.ui.form.Button("Save").set({
                        enabled: false,
                        width: 85
                    });

                    var hbox1 = new qx.ui.container.Composite(new qx.ui.layout.HBox(10));
                    var hbox2 = new qx.ui.container.Composite(new qx.ui.layout.HBox(10));

                    hbox1.add(addButton);
                    hbox1.add(removeButton);

                    hbox2.add(saveButton);
                    hbox2.add(defaultsButton);

                    this.searchBox = searchBox;
                    this.list = list;
                    this.editList = editList;
                    this.radioGroup = radioGroup;
                    this.colorSelectBox = colorSelectBox;
                    this.addButton = addButton;
                    this.removeButton = removeButton;
                    this.saveButton = saveButton;
                    this.defaultsButton = defaultsButton;
                    this.applyButton = applyButton;

                    this.add(searchBox);
                    this.add(list);
                    this.add(editList);
                    this.add(radioGroupC);
                    this.add(colorSelectBox);
                    this.add(hbox1);
                    this.add(hbox2);
                    this.add(applyButton);

                    this.addListener("appear", function () {
                        var cont = cdccta_map.container.getInstance();
                        var bounds = cont.getBounds(),
                            left = bounds.left,
                            top = bounds.top,
                            width = bounds.width,
                            height = bounds.height;
                        searchBox.setValue("");
                        list.removeAll();
                        addButton.setEnabled(false);
                        removeButton.setEnabled(false);
                        applyButton.setEnabled(false);
                        radioGroup.setSelection([radioGroup.getSelectables()[0]]);
                        colorSelectBox.setSelection([colorSelectBox.getSelectables()[0]]);
                        this.__updateList();
                        this.__checkDefaults();
                        this.__checkSavedSettings();
                        this.setUserBounds(left + width + 5, top, 200, height);
                    }, this);

                    searchBox.addListener("keyup", this.__searchAlliances, this);

                    radioGroup.addListener("changeSelection", function (e) {
                        if (e.getData()[0]) addColors(e.getData()[0].getModel());
                    }, this);

                    list.addListener("changeSelection", function (e) {
                        if (!e.getData()[0]) return;
                        var items = this.__items,
                            aid = e.getData()[0].getModel();
                        if (!items) {
                            addButton.setEnabled(true);
                            return;
                        }
                        (((items != null) && (items.indexOf(aid) > -1)) || (items.length > 8)) ? addButton.setEnabled(false) : addButton.setEnabled(true);
                    }, this);

                    editList.addListener("changeSelection", function () {
                        var selection = (editList.isSelectionEmpty()) ? null : editList.getSelection();
                        var ownAlliance = cdccta_map.getInstance().__allianceName;
                        if (selection == null || (selection.length === 1 && selection[0].getModel().name === ownAlliance)) removeButton.setEnabled(false);
                        else removeButton.setEnabled(true);
                    }, this);

                    addButton.addListener("execute", function () {
                        var aid = list.getSelection()[0].getModel(),
                            name = list.getSelection()[0].getLabel(),
                            type = radioGroup.getSelection()[0].getModel(),
                            color = colorSelectBox.getSelection()[0].getModel();

                        var li = new qx.ui.form.ListItem(name + " - " + type, root.__createIcon(colors[type][color], 15, 15), {
                            "aid": aid,
                            "type": type,
                            "name": name,
                            "color": color
                        });
                        editList.add(li);
                        list.resetSelection();
                        addButton.setEnabled(false);
                        root.__updateItems();
                    }, this);

                    removeButton.addListener("execute", function () {
                        var selection = (editList.isSelectionEmpty()) ? null : editList.getSelection();
                        var ownAlliance = cdccta_map.getInstance().__allianceName;
                        if (selection != null) {
                            for (var i = selection.length - 1; i > -1; i--) {
                                if (selection[i].getModel().name !== ownAlliance) editList.remove(selection[i]);
                            }
                            root.__updateItems();
                            editList.resetSelection();
                        }
                    }, this);

                    applyButton.addListener("execute", this.__applyChanges, this);
                    defaultsButton.addListener("execute", this.__setDefaults, this);
                    saveButton.addListener("execute", this.__saveSettings, this);

                } catch (e) {
                    console.log(e.toString());
                }
                console.log("Options Panel creation completed");
            },

            members: {
                __data: null,
                searchBox: null,
                list: null,
                editList: null,
                radioGroup: null,
                colorSelectBox: null,
                addButton: null,
                removeButton: null,
                saveButton: null,
                applyButton: null,
                defaultsButton: null,
                __items: null,
                __colors: {
                    "enemy": ["#ff807d", "#a93939", "#739bf5", "#c26b89"],
                    "ally": ["#3bbe5d", "#c4d663", "#73f5ed", "#169f16"],
                    "nap": ["#ffffff"],
                    "selected": ["#ffe50e"],
                    "alliance": ["#75b7d9"],
                    "owner": ["#ffc48b"]
                },

                __getAlliances: function () {
                    var root = this;
                    ClientLib.Net.CommunicationManager.GetInstance().SendSimpleCommand("RankingGetData", {
                        firstIndex: 0,
                        lastIndex: 3000,
                        ascending: true,
                        view: 1,
                        rankingType: 0,
                        sortColumn: 2
                    },
                                                                                       phe.cnc.Util.createEventDelegate(ClientLib.Net.CommandResult, this, function (context, data) {
                        if (data.a != null) {
                            var arr = [];
                            for (var i = 0; i < data.a.length; i++) arr[i] = [data.a[i].an, data.a[i].a];
                            root.__data = arr;
                        }
                    }), null);
                },

                __createIcon: function (color, width, height) {
                    var canvas = document.createElement("canvas");
                    canvas.width = width;
                    canvas.height = height;

                    var ctx = canvas.getContext("2d");
                    ctx.beginPath();
                    ctx.rect(0, 0, width, height);
                    ctx.fillStyle = color;
                    ctx.fill();
                    ctx.closePath();

                    return canvas.toDataURL("image/png");
                },

                __updateList: function () {
                    var map = cdccta_map.getInstance();
                    var selectedItems = [],
                        list = this.editList,
                        root = this;
                    var alliancesList = (map.__selectedAlliances == null) ? map.__defaultAlliances : map.__selectedAlliances;
                    if (!alliancesList) return;
                    var colors = this.__colors;
                    list.removeAll();

                    alliancesList.map(function (a) {
                        var aid = a[0],
                            at = a[1],
                            an = a[2],
                            c = a[3];
                        var li = new qx.ui.form.ListItem(an + " - " + at, root.__createIcon(colors[at][c], 15, 15), {
                            "aid": aid,
                            "type": at,
                            "name": an,
                            "color": c
                        });
                        list.add(li);
                        selectedItems.push(aid);
                    });
                    this.__items = selectedItems;
                },

                __setDefaults: function () {
                    var map = cdccta_map.getInstance();
                    var selectedItems = [],
                        list = this.editList,
                        root = this,
                        colors = this.__colors;
                    var alliancesList = map.__defaultAlliances;
                    list.removeAll();

                    alliancesList.map(function (a) {
                        var aid = a[0],
                            at = a[1],
                            an = a[2],
                            c = a[3];
                        var li = new qx.ui.form.ListItem(an + " - " + at, root.__createIcon(colors[at][c], 15, 15), {
                            "aid": aid,
                            "type": at,
                            "name": an,
                            "color": c
                        });
                        list.add(li);
                        selectedItems.push(aid);
                    });
                    this.__items = selectedItems;
                    this.__currentListModified();
                    this.defaultsButton.setEnabled(false);
                },

                /*
                 * Filter the alliance picker by prefix text.
                 */
                __searchAlliances: function () {
                    var str = this.searchBox.getValue(),
                        data = this.__data,
                        list = this.list;
                    list.removeAll();
                    if (!data || (str === "")) return;

                    data.map(function (x) {
                        var patt = new RegExp("^" + str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ".+$", "i");
                        if (patt.test(x[0])) {
                            var listItem = new qx.ui.form.ListItem(x[0], null, x[1]);
                            list.add(listItem);
                        }
                    });
                },

                __updateItems: function () {
                    var items = [],
                        listItems = this.editList.getSelectables();
                    for (var i = 0; i < listItems.length; i++) items.push(listItems[i].getModel().aid);
                    this.__items = items;
                    this.__checkSavedSettings();
                    this.__currentListModified();
                },

                /*
                 * Commit the selected alliance list back to the main map and trigger a redraw.
                 */
                __applyChanges: function () {
                    var selectedAlliances = [],
                        listItems = this.editList.getSelectables();
                    for (var i = 0; i < listItems.length; i++) {
                        var model = listItems[i].getModel(),
                            aid = model.aid,
                            type = model.type,
                            name = model.name,
                            color = model.color;
                        selectedAlliances.push([aid, type, name, color]);
                    }
                    cdccta_map.getInstance().__selectedAlliances = selectedAlliances;
                    cdccta_map.container.getInstance().resetMap();
                    cdccta_map.getInstance().getData();
                    this.close();
                },

                /*
                 * Persist the current alliance selection into localStorage.
                 */
                __saveSettings: function () {
                    if (typeof Storage === "undefined") return;

                    var selectedAlliances = [],
                        listItems = this.editList.getSelectables();
                    for (var i = 0; i < listItems.length; i++) {
                        var model = listItems[i].getModel(),
                            aid = model.aid,
                            type = model.type,
                            name = model.name,
                            color = model.color;
                        selectedAlliances.push([aid, type, name, color]);
                    }

                    localStorage.cdccta_map_settings = JSON.stringify(selectedAlliances);
                    this.saveButton.setEnabled(false);
                },

                __checkSavedSettings: function () {
                    if (typeof Storage === "undefined") return;
                    var original = (localStorage.cdccta_map_settings) ? JSON.parse(localStorage.cdccta_map_settings) : null;
                    var items = this.__items;
                    var changed = false;
                    if (!items) return;
                    if ((items != null) && (original != null) && (items.length !== original.length)) changed = true;
                    if ((items != null) && (original != null) && (items.length === original.length)) {
                        original.map(function (x) {
                            if (items.indexOf(x[0]) < 0) changed = true;
                        });
                    }
                    ((original === null) || changed) ? this.saveButton.setEnabled(true) : this.saveButton.setEnabled(false);
                },

                __checkDefaults: function () {
                    var defaults = cdccta_map.getInstance().__defaultAlliances,
                        items = this.__items,
                        changed = false;
                    if (!defaults) return;
                    if ((items != null) && (defaults != null) && (items.length !== defaults.length)) changed = true;
                    if ((items != null) && (defaults != null) && (items.length === defaults.length)) {
                        defaults.map(function (x) {
                            if (items.indexOf(x[0]) < 0) changed = true;
                        });
                    }
                    (changed) ? this.defaultsButton.setEnabled(true) : this.defaultsButton.setEnabled(false);
                },

                __currentListModified: function () {
                    var map = cdccta_map.getInstance(),
                        current = (map.__selectedAlliances == null) ? map.__defaultAlliances : map.__selectedAlliances;
                    var items = this.__items,
                        changed = false;
                    if (!current || !items) {
                        this.applyButton.setEnabled(true);
                        return;
                    }
                    current.map(function (x) {
                        if (items.indexOf(x[0]) < 0) changed = true;
                    });
                    (items.length !== current.length) || (changed === true) ? this.applyButton.setEnabled(true) : this.applyButton.setEnabled(false);
                }
            }
        });

        qx.Class.define("cdccta_map.poiexport", {
            type: "singleton",
            extend: webfrontend.gui.CustomWindow,

            construct: function () {
                try {
                    this.base(arguments);
                    this.setLayout(new qx.ui.layout.VBox(8));
                    this.set({
                        width: 320,
                        height: 720,
                        showMinimize: true,
                        showMaximize: true,
                        alwaysOnTop: true,
                        caption: "Export POI Information"
                    });

                    var contentScroll = new qx.ui.container.Scroll().set({
                        allowStretchX: true,
                        allowStretchY: true
                    });
                    var content = new qx.ui.container.Composite(new qx.ui.layout.VBox(8)).set({
                        padding: 4,
                        width: 290
                    });
                    contentScroll.add(content);
                    this.add(contentScroll, { flex: 1 });

                    var typesLabel = new qx.ui.basic.Label("POI Type");
                    typesLabel.setTextColor("#ffffff");
                    content.add(typesLabel);

                    var typeScroll = new qx.ui.container.Scroll().set({
                        width: 280,
                        height: 150
                    });
                    var typeBox = new qx.ui.container.Composite(new qx.ui.layout.VBox(4));
                    typeScroll.add(typeBox);
                    content.add(typeScroll);

                    var checks = {};
                    var map = cdccta_map.getInstance();
                    var types = map.getPoiTypes();
                    var typeIds = [];
                    for (var t in types) typeIds.push(parseInt(t, 10));
                    typeIds.sort(function (a, b) { return a - b; });

                    for (var i = 0; i < typeIds.length; i++) {
                        var typeId = typeIds[i];
                        var cb = new qx.ui.form.CheckBox(types[typeId].label);
                        cb.setTextColor("#ffffff");
                        try { cb.getChildControl("label").setTextColor("#ffffff"); } catch (e0) {}
                        cb.setModel(String(typeId));
                        checks[String(typeId)] = cb;
                        typeBox.add(cb);
                    }

                    var typeBtnRow = new qx.ui.container.Composite(new qx.ui.layout.HBox(6));
                    var btnAllTypes = new qx.ui.form.Button("All Types");
                    var btnNoTypes = new qx.ui.form.Button("Clear Types");
                    typeBtnRow.add(btnAllTypes);
                    typeBtnRow.add(btnNoTypes);
                    content.add(typeBtnRow);

                    var minLevelLabel = new qx.ui.basic.Label("Minimum Level");
                    minLevelLabel.setTextColor("#ffffff");
                    content.add(minLevelLabel);

                    var minLevelField = new qx.ui.form.TextField("12").set({
                        width: 120,
                        maxLength: 3,
                        filter: /[0-9]/
                    });
                    content.add(minLevelField);

                    var maxLevelLabel = new qx.ui.basic.Label("Maximum Level");
                    maxLevelLabel.setTextColor("#ffffff");
                    content.add(maxLevelLabel);

                    var maxLevelField = new qx.ui.form.TextField("").set({
                        width: 120,
                        maxLength: 3,
                        filter: /[0-9]/
                    });
                    content.add(maxLevelField);

                    var allianceLabel = new qx.ui.basic.Label("Alliance (Top 10 Ranked)");
                    allianceLabel.setTextColor("#ffffff");
                    content.add(allianceLabel);

                    var allianceScroll = new qx.ui.container.Scroll().set({
                        width: 280,
                        height: 120
                    });
                    var allianceBox = new qx.ui.container.Composite(new qx.ui.layout.VBox(4));
                    allianceScroll.add(allianceBox);
                    content.add(allianceScroll);

                    var allianceHint = new qx.ui.basic.Label("Leave all unchecked to include all alliances.").set({
                        rich: true,
                        wrap: true,
                        textColor: "#c7d7dc"
                    });
                    content.add(allianceHint);

                    var allianceBtnRow = new qx.ui.container.Composite(new qx.ui.layout.HBox(6));
                    var btnAllAlliances = new qx.ui.form.Button("Top 10");
                    var btnClearAlliances = new qx.ui.form.Button("Clear Alliances");
                    allianceBtnRow.add(btnAllAlliances);
                    allianceBtnRow.add(btnClearAlliances);
                    content.add(allianceBtnRow);

                    var statusLabel = new qx.ui.basic.Label("").set({
                        rich: true,
                        wrap: true,
                        textColor: "#c7d7dc"
                    });
                    content.add(statusLabel);

                    var exportBtn = new qx.ui.form.Button("Download CSV");
                    content.add(exportBtn);

                    var exportInfoLabel = new qx.ui.form.TextArea(
                        "Alliance filtering for export POI uses cached POI ownership data\n" +
                        "If selected alliances returns empty, scan/cache more POIs by clicking on empty spaces on PvP Map\n\n" +
                        "If you wish to hard reset the POI cache, open Chrome console (F12) and paste the following code, then press Enter:\n\n" +
                        'localStorage.removeItem("cdccta_map_poi_cache_" + ClientLib.Data.MainData.GetInstance().get_Server().get_WorldId());'
                    ).set({
                        readOnly: true,
                        wrap: true,
                        width: 280,
                        height: 135
                    });
                    content.add(exportInfoLabel);

                    this.__checks = checks;
                    this.__typeBox = typeBox;
                    this.__allianceBox = allianceBox;
                    this.__allianceChecks = {};
                    this.__minLevelField = minLevelField;
                    this.__maxLevelField = maxLevelField;
                    this.__statusLabel = statusLabel;
                    this.__allianceRefreshToken = 0;

                    btnAllTypes.addListener("execute", function () {
                        for (var key in checks) checks[key].setValue(true);
                    }, this);

                    btnNoTypes.addListener("execute", function () {
                        for (var key in checks) checks[key].setValue(false);
                    }, this);

                    btnAllAlliances.addListener("execute", function () {
                        var checks = this.__allianceChecks || {};
                        for (var allianceKey in checks) checks[allianceKey].setValue(true);
                    }, this);

                    btnClearAlliances.addListener("execute", function () {
                        var checks = this.__allianceChecks || {};
                        for (var allianceKey in checks) checks[allianceKey].setValue(false);
                    }, this);

                    exportBtn.addListener("execute", function () {
                        try {
                            var selectedTypes = [];
                            for (var key in checks) {
                                if (checks[key].getValue()) selectedTypes.push(parseInt(key, 10));
                            }

                            var rawMinLevel = minLevelField.getValue();
                            rawMinLevel = map.__trimString(rawMinLevel);
                            var minimumLevel = rawMinLevel === "" ? "" : parseInt(rawMinLevel, 10);

                            if (rawMinLevel !== "" && (isNaN(minimumLevel) || minimumLevel < 0)) {
                                statusLabel.setValue("<span style='color:#ff9b9b'>Minimum Level must be blank or a valid number.</span>");
                                return;
                            }

                            var rawMaxLevel = maxLevelField.getValue();
                            rawMaxLevel = map.__trimString(rawMaxLevel);
                            var maximumLevel = rawMaxLevel === "" ? "" : parseInt(rawMaxLevel, 10);

                            if (rawMaxLevel !== "" && (isNaN(maximumLevel) || maximumLevel < 0)) {
                                statusLabel.setValue("<span style='color:#ff9b9b'>Maximum Level must be blank or a valid number.</span>");
                                return;
                            }

                            if (rawMinLevel !== "" && rawMaxLevel !== "" && minimumLevel > maximumLevel) {
                                statusLabel.setValue("<span style='color:#ff9b9b'>Minimum Level cannot be greater than Maximum Level.</span>");
                                return;
                            }

                            var selectedAlliances = [];
                            var currentAllianceChecks = this.__allianceChecks || {};
                            for (var allianceKey in currentAllianceChecks) {
                                if (!currentAllianceChecks[allianceKey].getValue()) continue;
                                var meta = currentAllianceChecks[allianceKey].getUserData("allianceMeta");
                                if (!meta) continue;
                                selectedAlliances.push({
                                    id: meta.id,
                                    name: meta.name || "",
                                    label: currentAllianceChecks[allianceKey].getLabel ? (currentAllianceChecks[allianceKey].getLabel() || "") : ""
                                });
                            }

                            var result = map.exportPoisToCsv({
                                poiTypes: selectedTypes,
                                minimumLevel: minimumLevel,
                                maximumLevel: maximumLevel,
                                alliances: selectedAlliances
                            });

                            statusLabel.setValue("Exported <b>" + result.count + "</b> POIs to <b>" + result.fileName + "</b>.");
                        } catch (e1) {
                            console.log("POI export error:", e1);
                            statusLabel.setValue("<span style='color:#ff9b9b'>Export failed. Check console for details.</span>");
                        }
                    }, this);

                    this.addListener("appear", function () {
                        this.positionNextToMainWindow();
                    }, this);

                } catch (e) {
                    console.log("poiexport error:", e);
                }
            },

            members: {
                __checks: null,
                __typeBox: null,
                __allianceBox: null,
                __allianceChecks: null,
                __minLevelField: null,
                __maxLevelField: null,
                __statusLabel: null,
                __allianceRefreshToken: 0,

                open: function () {
                    this.base(arguments);
                    qx.event.Timer.once(function () {
                        this.__refreshAllianceOptions();
                        this.positionNextToMainWindow();
                    }, this, 1);
                },

                __refreshAllianceOptions: function () {
                    var box = this.__allianceBox;
                    if (!box) return;

                    var refreshToken = ++this.__allianceRefreshToken;
                    var selectedIds = {};
                    var currentChecks = this.__allianceChecks || {};
                    for (var key in currentChecks) {
                        if (!currentChecks[key].getValue()) continue;
                        var currentMeta = currentChecks[key].getUserData("allianceMeta");
                        if (currentMeta && currentMeta.id != null) selectedIds[String(currentMeta.id)] = true;
                    }

                    box.removeAll();
                    this.__allianceChecks = {};
                    this.__statusLabel.setValue("Loading top 10 alliances...");

                    cdccta_map.getInstance().loadTopRankedAllianceOptions(function (options) {
                        if (refreshToken !== this.__allianceRefreshToken) return;

                        var seen = {};
                        var uniqueOptions = [];
                        for (var i = 0; i < options.length; i++) {
                            var option = options[i];
                            var optionId = option && option.id != null ? String(option.id) : "";
                            if (!optionId || seen[optionId]) continue;
                            seen[optionId] = true;
                            uniqueOptions.push(option);
                        }

                        for (var j = 0; j < uniqueOptions.length; j++) {
                            var opt = uniqueOptions[j];
                            var optId = String(opt.id);
                            var cb = new qx.ui.form.CheckBox(opt.name);
                            cb.setValue(!!selectedIds[optId]);
                            cb.setTextColor("#ffffff");
                            try { cb.getChildControl("label").setTextColor("#ffffff"); } catch (e0) {}
                            cb.setUserData("allianceMeta", {
                                id: opt.id,
                                name: opt.name
                            });
                            this.__allianceChecks[optId] = cb;
                            box.add(cb);
                        }

                        if (uniqueOptions.length) {
                            this.__statusLabel.setValue("Leave all unchecked for all alliances, or check one or more from the current top 10.");
                        } else {
                            this.__statusLabel.setValue("<span style='color:#ff9b9b'>Could not load top 10 alliances.</span>");
                        }
                    }.bind(this));
                },

                positionNextToMainWindow: function () {
                    var cont = cdccta_map.container.getInstance();
                    var bounds = cont && cont.getBounds ? cont.getBounds() : null;
                    if (!bounds) return;
                    var h = Math.min(500, Math.max(360, window.innerHeight - 20));
                    var top = Math.max(5, Math.min(bounds.top, window.innerHeight - h - 10));
                    var left = Math.max(5, bounds.left - 325);
                    this.setUserBounds(left, top, 320, h);
                }
            }
        });

        qx.Class.define("cdccta_map.poioptions", {
            type: "singleton",
            extend: webfrontend.gui.CustomWindow,

            /*
             * Entry point for the singleton.
             * Wait until world/endgame data is available, then initialize the script UI.
             */
            construct: function () {
                try {
                    this.base(arguments);
                    this.setLayout(new qx.ui.layout.VBox(6));
                    this.set({
                        width: 235,
                        height: 320,
                        showMinimize: true,
                        showMaximize: true,
                        alwaysOnTop: true,
                        caption: "POI Types Shown on Map"
                    });

                    var map = cdccta_map.getInstance();
                    var checks = {};
                    var types = map.getPoiTypes();

                    for (var t in types) {
                        var cb = new qx.ui.form.CheckBox(types[t].label);
                        cb.setValue(!!map.__poiFilters[t]);
                        cb.setTextColor("#ffffff");
                        try {
                            cb.getChildControl("label").setTextColor("#ffffff");
                        } catch (e) {}
                        checks[t] = cb;
                        this.add(cb);
                    }

                    var row = new qx.ui.container.Composite(new qx.ui.layout.HBox(6));
                    var btnAll = new qx.ui.form.Button("All");
                    var btnNone = new qx.ui.form.Button("None");
                    row.add(btnAll);
                    row.add(btnNone);

                    var btnApply = new qx.ui.form.Button("Apply");

                    this.add(row);
                    this.add(btnApply);

                    this.__checks = checks;

                    btnAll.addListener("execute", function () {
                        for (var k in checks) checks[k].setValue(true);
                    }, this);

                    btnNone.addListener("execute", function () {
                        for (var k in checks) checks[k].setValue(false);
                    }, this);

                    btnApply.addListener("execute", function () {
                        var newFilters = {};
                        for (var k in checks) newFilters[k] = !!checks[k].getValue();

                        map.__poiFilters = newFilters;
                        map.savePoiFilters();

                        var cont = cdccta_map.container.getInstance();
                        cont.__updatePoiSummary();
                        cont.drawCanvas();

                        this.close();
                    }, this);

                    this.addListener("appear", function () {
                        this.positionNextToMainWindow();
                    }, this);

                } catch (e) {
                    console.log("poioptions error:", e);
                }
            },

            members: {
                __checks: null,

                /*
                 * Open the map window and refresh UI elements that depend on current POI cache state.
                 */
                open: function () {
                    this.base(arguments);
                    qx.event.Timer.once(function () {
                        this.positionNextToMainWindow();
                    }, this, 1);
                },

                positionNextToMainWindow: function () {
                    var cont = cdccta_map.container.getInstance();
                    var bounds = cont && cont.getBounds ? cont.getBounds() : null;
                    if (!bounds) return;
                    this.setUserBounds(bounds.left - 240, bounds.top, 235, 320);
                }
            }
        });
    }

    var cctaMapLoader = function () {
        var qxRef = window.qx;
        var ClientLibRef = window.ClientLib;
        var webfrontendRef = window.webfrontend;

        if ((typeof ClientLibRef === "undefined") || (typeof qxRef === "undefined") || (typeof webfrontendRef === "undefined") || (qx.core.Init.getApplication().initDone === false)) {
            setTimeout(cctaMapLoader, 1000);
            console.log("retrying....");
        } else {
            create_cdccta_map_class();
            cdccta_map.getInstance();
        }
    };

    window.setTimeout(cctaMapLoader, 10000);
})();