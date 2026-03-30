// ==UserScript==
// @name        CnCTA TargetWatcher Enhancer
// @description Enhances alliance target watcher labels in C&C:TA with auto-detected ID fields and watcher-priority sorting / Game version: 25.2.1 / Last EA maintenance on 24 March 2026
// @version     2026.03.30
// @author      bloofi (https://github.com/bloofi) / Fixed by tacc00
// @include     http*://prodgame*.alliances.commandandconquer.com/*/index.aspx*
// @include     http*://cncapp*.alliances.commandandconquer.com/*/index.aspx*
// ==/UserScript==

(function () {
    "use strict";

    const script = () => {
        const scriptName = "CnCTA TargetWatcher Enhancer";

        const colors = {
            0: "#cccccc",
            1: "gold",
            2: "#cccccc",
            3: "#cccccc",
        };

        const markerColors = {
            0: "rgba(150, 150, 150, 0.5)",
            1: "rgba(21, 60, 200, 0.8)",
            2: "rgba(188, 143, 28, 0.85)",
            3: "rgba(200, 21, 21, 0.5)",
        };

        const watcherPriority = {
            1: 0,
            2: 1,
            3: 2,
            0: 99,
        };

        const getWatcherPriority = (state) => (
            Object.prototype.hasOwnProperty.call(watcherPriority, state)
                ? watcherPriority[state]
                : 99
        );

        const safeGetWatchers = () => {
            const store = ClientLib.Data.MainData.GetInstance().get_AllianceWatchListWatcher();
            if (!store || typeof store !== "object") return [];
            return Object.values(store).reduce((acc, value) => {
                if (value && typeof value === "object") {
                    return acc.concat(Object.values(value));
                }
                return acc;
            }, []).filter(w => w && typeof w === "object" && "b" in w && "p" in w);
        };

        const safeGetMembers = () => {
            const alliance = ClientLib.Data.MainData.GetInstance().get_Alliance();
            if (!alliance || !alliance.get_MemberDataAsArray) return [];
            return alliance.get_MemberDataAsArray() || [];
        };

        const getRegionCollections = () => {
            const region = ClientLib.Vis.VisMain.GetInstance().get_Region();
            const collections = [];

            const pushCollection = (name, getter) => {
                try {
                    if (typeof getter === "function") {
                        const result = getter.call(region);
                        const data = result && result.d ? Object.values(result.d) : [];
                        if (data.length) collections.push({ name, items: data });
                    }
                } catch (_e) {
                    // ignore
                }
            };

            pushCollection("camp", region.GetNPCCamps);
            pushCollection("base", region.GetNPCBases);
            pushCollection("outpost", region.GetNPCOutposts);

            return collections;
        };

        const autoDetectIdFields = (watchers) => {
            const watcherIds = new Set(watchers.map(w => w.b));
            if (!watcherIds.size) return {};

            const detected = {};
            const collections = getRegionCollections();

            collections.forEach(({ name, items }) => {
                const counts = {};
                items.forEach(item => {
                    if (!item || typeof item !== "object") return;
                    Object.entries(item).forEach(([key, value]) => {
                        if (typeof value === "number" && watcherIds.has(value)) {
                            counts[key] = (counts[key] || 0) + 1;
                        }
                    });
                });
                const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
                if (best) detected[name] = best[0];
            });

            return detected;
        };

        const init = () => {
            const me = ClientLib.Data.MainData.GetInstance().get_Player();

            const updateLabel = () => {
                const divParent = qx.core.Init.getApplication()
                    .getUIItem(ClientLib.Data.Missions.PATH.OVL_PLAYAREA)
                    .getChildren()[10];
                if (!divParent) return;

                const divParentEl = divParent.getContentElement();
                if (divParentEl && !divParentEl.realSetStyles) {
                    divParentEl.realSetStyles = divParentEl.setStyles;
                    divParentEl.setStyles = () => {
                        divParentEl.realSetStyles({
                            right: "30px",
                            left: "unset",
                            width: "35%",
                            height: "60px",
                            overflow: "visible",
                        });
                    };
                }

                const divLabel = divParent.getChildren()[0];
                if (!divLabel) return;

                const divLabelEl = divLabel.getContentElement();
                if (divLabelEl && !divLabelEl.realSetStyles) {
                    divLabelEl.realSetStyles = divLabelEl.setStyles;
                    divLabelEl.setStyles = () => {
                        divLabelEl.realSetStyles({
                            height: "100%",
                            width: "100%",
                        });
                    };
                }

                if (divLabel.realSetValue) return;

                divLabel.realSetValue = divLabel.setValue;
                divLabel.setValue = (value) => {
                    const myId = ClientLib.Data.MainData.GetInstance().get_Player().get_Id();
                    const bid = ClientLib.Data.MainData.GetInstance().get_AllianceTargetWatcher().get_BaseId();
                    const members = safeGetMembers();
                    const watchers = safeGetWatchers();

                    const labels = [];
                    const timerLabel = /(?:<img.*)?\d{2}:\d{2}$/.exec(value);
                    if (timerLabel) labels.push(timerLabel[0], "<br>");

                    switch (qx.core.Init.getApplication().getPlayArea().getViewMode()) {
                        case 5:
                        case 8:
                        case 10: {
                            const res = watchers
                                .filter(w => w.b === bid && w.p !== myId)
                                .map(w => {
                                    const m = members.find(member => member.Id === w.p);
                                    return m ? { ...w, n: m.Name, s: m.OnlineState } : null;
                                })
                                .filter(Boolean)
                                .sort((a, b) => getWatcherPriority(a.s) - getWatcherPriority(b.s));

                            if (res.length) {
                                const label = `${res
                                    .map(w => `<span style="color:${colors[w.s] || colors[0]};">${w.n}</span>`)
                                    .join(", ")} ${res.length > 1 ? "are" : "is"} watching !`;
                                labels.push(label);
                            }
                            break;
                        }
                        default:
                            labels.splice(0, labels.length);
                            labels.push(value);
                            break;
                    }

                    labels.reverse();
                    divLabel.realSetValue(labels.join(""));
                };
            };

            updateLabel();

            let gridWidth = null;
            let gridHeight = null;
            const markers = {};
            const citiesCache = {};
            const detectedIdFields = {};

            const removeMarker = (x, y) => {
                if (markers[`${x}:${y}`] && markers[`${x}:${y}`].marker) {
                    qx.core.Init.getApplication().getDesktop().remove(markers[`${x}:${y}`].marker);
                    markers[`${x}:${y}`].marker.dispose();
                    delete markers[`${x}:${y}`];
                }
            };

            const removeMarkers = () => {
                Object.values(markers).forEach(marker => {
                    if (marker) removeMarker(marker.x, marker.y);
                });
            };

            const updateMarkerSize = () => {
                const region = ClientLib.Vis.VisMain.GetInstance().get_Region();
                gridWidth = region.get_GridWidth();
                gridHeight = region.get_GridHeight();
                region.get_ZoomFactor();
            };

            const repositionMarkers = () => {
                updateMarkerSize();
                Object.values(markers).forEach(m => {
                    m.marker.setDomLeft(ClientLib.Vis.VisMain.GetInstance().ScreenPosFromWorldPosX(m.x * gridWidth));
                    m.marker.setDomTop(ClientLib.Vis.VisMain.GetInstance().ScreenPosFromWorldPosY(m.y * gridHeight));
                });
            };

            const resizeMarkers = () => {
                updateMarkerSize();
            };

            const addMarker = (x, y, names, states) => {
                const bestState = states.length ? states[0] : 0;
                const fillColor = markerColors[bestState] || markerColors[0];

                const marker = new qx.ui.container.Composite(new qx.ui.layout.Atom()).set({
                    decorator: new qx.ui.decoration.Decorator().set({
                        color: "rgba(200, 21, 21, 0.8)",
                        style: "solid",
                        width: 2,
                        radius: 5,
                    }),
                });

                const label = new qx.ui.basic.Label("").set({
                    decorator: new qx.ui.decoration.Decorator().set({
                        color: fillColor,
                        style: "solid",
                        width: 1,
                        radius: 5,
                    }),
                    value: names.length ? `${names[0]}${names.length > 1 ? ", ..." : ""}` : "",
                    toolTipText: names.length > 1 ? `Other watchers : ${names.slice(1).join(", ")}` : "",
                    textColor: "#ffffff",
                    textAlign: "center",
                    backgroundColor: fillColor,
                    font: new qx.bom.Font(10, ["Arial"]),
                    rich: true,
                    wrap: false,
                    padding: 3,
                    allowGrowX: true,
                    allowShrinkX: false,
                });

                marker.add(label, { edge: "north" });

                qx.core.Init.getApplication().getDesktop().addAfter(
                    marker,
                    qx.core.Init.getApplication().getBackgroundArea(),
                    {
                        left: ClientLib.Vis.VisMain.GetInstance().ScreenPosFromWorldPosX(x * gridWidth),
                        top: ClientLib.Vis.VisMain.GetInstance().ScreenPosFromWorldPosY(y * gridHeight),
                    }
                );

                markers[`${x}:${y}`] = { x, y, names, marker };
            };

            phe.cnc.Util.attachNetEvent(
                ClientLib.Vis.VisMain.GetInstance().get_Region(),
                "ZoomFactorChange",
                ClientLib.Vis.ZoomFactorChange,
                this,
                resizeMarkers
            );
            phe.cnc.Util.attachNetEvent(
                ClientLib.Vis.VisMain.GetInstance().get_Region(),
                "PositionChange",
                ClientLib.Vis.PositionChange,
                this,
                repositionMarkers
            );

            updateMarkerSize();

            const buildAllItems = (watchers) => {
                Object.assign(detectedIdFields, autoDetectIdFields(watchers));

                const items = [];
                getRegionCollections().forEach(({ name, items: collectionItems }) => {
                    const idField = detectedIdFields[name];
                    if (!idField) return;
                    collectionItems.forEach(item => {
                        const id = item && item[idField];
                        if (typeof id === "number" && typeof item.posX === "number" && typeof item.posY === "number") {
                            items.push({ id, x: item.posX, y: item.posY, type: name });
                        }
                    });
                });
                return items;
            };

            const checkWatchers = () => {
                removeMarkers();

                if (
                    qx.core.Init.getApplication().getPlayArea().getViewMode() === 0 &&
                    !qx.core.Init.getApplication().getCurrentMenuOverlay()
                ) {
                    const members = safeGetMembers();
                    const watchers = safeGetWatchers();
                    const allItems = buildAllItems(watchers);

                    const markerGroups = watchers
                        .filter(w => w.p !== me.get_Id())
                        .reduce((acc, watcher) => {
                            if (!acc[`${watcher.b}`]) {
                                let city = citiesCache[`${watcher.b}`];
                                if (!city) {
                                    city = allItems.find(item => item.id === watcher.b);
                                    if (city) citiesCache[`${watcher.b}`] = { x: city.x, y: city.y };
                                }
                                acc[`${watcher.b}`] = {
                                    isLoaded: !!city,
                                    x: city ? city.x : null,
                                    y: city ? city.y : null,
                                    watchers: [],
                                };
                            }

                            const member = members.find(m => m.Id === watcher.p);
                            if (member && member.OnlineState !== 0) {
                                acc[`${watcher.b}`].watchers.push({
                                    name: member.Name,
                                    state: member.OnlineState,
                                });
                            }

                            return acc;
                        }, {});

                    Object.values(markerGroups)
                        .filter(group => group.isLoaded && group.watchers.length)
                        .forEach(group => {
                            group.watchers.sort((a, b) => getWatcherPriority(a.state) - getWatcherPriority(b.state));
                            const names = group.watchers.map(w => w.name);
                            const states = group.watchers.map(w => w.state);
                            addMarker(group.x, group.y, names, states);
                        });
                }

                setTimeout(checkWatchers, 3000);
            };

            checkWatchers();
        };

        const checkForInit = () => {
            try {
                if (
                    typeof qx !== "undefined" &&
                    qx &&
                    qx.core &&
                    qx.core.Init &&
                    qx.core.Init.getApplication &&
                    qx.core.Init.getApplication() &&
                    qx.core.Init.getApplication().initDone
                ) {
                    init();
                } else {
                    window.setTimeout(checkForInit, 1000);
                }
            } catch (e) {
                console.log(scriptName, e);
            }
        };

        checkForInit();
    };

    if (/commandandconquer\.com/i.test(document.domain)) {
        try {
            const scriptBlock = document.createElement("script");
            scriptBlock.innerHTML = `(${script.toString()})();`;
            scriptBlock.type = "text/javascript";
            document.getElementsByTagName("head")[0].appendChild(scriptBlock);
        } catch (e) {
            console.log("Failed to inject script", e);
        }
    }
})();