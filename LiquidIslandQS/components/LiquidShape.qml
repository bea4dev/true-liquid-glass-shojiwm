import QtQuick

// Geometry in LiquidGroup-local logical pixels. Animate these independently.
QtObject {
    property real x: 0
    property real y: 0
    property real width: 64
    property real height: 64
    property real radius: 32
    // Shrinks around the center; zero removes the shape from the union.
    property real presence: 1
    // Set when removal is requested, before the geometry animation finishes.
    property bool retiring: false
}
