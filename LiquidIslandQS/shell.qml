import QtQuick
import Quickshell
import Quickshell.Wayland
import "components"

ShellRoot {
    PanelWindow {
        id: panel
        property real uiScale: 2.0
        color: "transparent"
        implicitWidth: demo.implicitWidth * uiScale
        implicitHeight: demo.implicitHeight * uiScale
        anchors.top: true
        margins.top: 64
        exclusiveZone: 0
        WlrLayershell.layer: WlrLayer.Top
        WlrLayershell.namespace: "liquid-island-qs"
        WlrLayershell.keyboardFocus: WlrKeyboardFocus.None

        mask: Region { item: scaledHitArea }

        // Explicit window-local input bounds, including the visual scale.
        Item {
            id: scaledHitArea
            x: demo.hitArea.x * panel.uiScale
            y: demo.hitArea.y * panel.uiScale
            width: demo.hitArea.width * panel.uiScale
            height: demo.hitArea.height * panel.uiScale
        }

        IslandDemo {
            id: demo
            width: implicitWidth
            height: implicitHeight
            scale: panel.uiScale
            transformOrigin: Item.TopLeft
        }
    }
}
