import QtQuick

Item {
    id: demo
    implicitWidth: 608
    implicitHeight: 144

    // 0 -> 1 -> 2 -> 1 -> 0 satellites, in reverse order on the way back.
    property int cycleStep: 0
    readonly property int satelliteCount: Math.min(cycleStep, 4 - cycleStep)
    readonly property bool expanded: satelliteCount > 0
    // Remaining linear size, not elapsed time. Clicks before this are discarded.
    property real recoveryRemainingRatio: 0.1
    readonly property bool canRetractParent: secondSatellite.retiring
        && secondSatellite.width <= 116 * Math.max(0, Math.min(1, recoveryRemainingRatio))
        && secondSatellite.height <= 64 * Math.max(0, Math.min(1, recoveryRemainingRatio))

    function advance(): void {
        if (cycleStep === 3 && !canRetractParent)
            return;
        cycleStep = (cycleStep + 1) % 4;
    }
    property int duration: 1000
    property int easingType: Easing.BezierSpline
    // Two control points followed by the required endpoint (1, 1).
    property list<real> easingBezierCurve: [0.1, 0.9, 0.2, 1.0, 1.0, 1.0]
    property real blendRadius: 40
    // Expose the interaction envelope for the PanelWindow input region.
    readonly property alias hitArea: interaction

    LiquidGroup {
        anchors.fill: parent
        blendRadius: demo.blendRadius
        shapes: [
            LiquidShape {
                id: mainShape
                x: 32
                y: 40
                width: demo.expanded ? 204 : 228
                height: 64
                radius: demo.expanded ? 24 : 32
                Behavior on width { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on radius { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
            },
            LiquidShape {
                id: satellite
                retiring: !demo.expanded
                x: demo.expanded ? 288 : 184
                width: demo.expanded ? 116 : 0
                height: demo.expanded ? 64 : 0
                y: 72 - height / 2
                radius: demo.expanded ? 24 : 0
                // Match travel timing so the satellite cannot grow ahead of its exit.
                Behavior on x { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on width { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on height { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on radius { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
            },
            LiquidShape {
                id: secondSatellite
                retiring: demo.satelliteCount !== 2
                // The next island emerges from the center of the first satellite.
                // Follow its moving parent directly, even during the final shrink.
                property real emergenceOffset: demo.satelliteCount === 2 ? 168 : 0
                x: satellite.x + satellite.width / 2 + emergenceOffset - width / 2
                width: demo.satelliteCount === 2 ? 116 : 0
                height: demo.satelliteCount === 2 ? 64 : 0
                y: 72 - height / 2
                radius: demo.satelliteCount === 2 ? 24 : 0
                Behavior on emergenceOffset { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on width { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on height { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
                Behavior on radius { NumberAnimation { duration: demo.duration; easing.type: demo.easingType; easing.bezierCurve: demo.easingBezierCurve } }
            }
        ]
    }

    // Content is independent of the fluid silhouette, ready for real controls.
    LiquidLabel {
        shape: mainShape
        text: "Liquid Island"
    }

    MouseArea {
        id: interaction
        x: 24
        y: 32
        // Follow actual animated bounds, keeping a retracting island clickable.
        width: Math.max(mainShape.x + mainShape.width,
                        satellite.width > 0.1 ? satellite.x + satellite.width : 0,
                        secondSatellite.width > 0.1 ? secondSatellite.x + secondSatellite.width : 0) + 8 - x
        height: 80
        cursorShape: Qt.PointingHandCursor
        onClicked: demo.advance()
    }
}
