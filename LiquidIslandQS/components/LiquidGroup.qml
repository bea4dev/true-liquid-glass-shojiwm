import QtQuick

ShaderEffect {
    id: group

    property list<LiquidShape> shapes: []
    property real blendRadius: 28
    property color tint: Qt.rgba(0.13, 0.19, 0.23, 0.20)
    readonly property vector2d resolution: Qt.vector2d(width, height)
    readonly property int shapeCount: Math.min(shapes.length, 8)

    function geometry(index: int): vector4d {
        if (index >= shapes.length)
            return Qt.vector4d(0, 0, 0, 0);
        const s = shapes[index];
        const p = Math.max(0, Math.min(1, s.presence));
        const w = Math.max(0, s.width);
        const h = Math.max(0, s.height);
        return Qt.vector4d(s.x + w * (1 - p) / 2,
                          s.y + h * (1 - p) / 2, w * p, h * p);
    }

    function corner(index: int): real {
        if (index >= shapes.length)
            return 0;
        const s = shapes[index];
        return Math.max(0, s.radius) * Math.max(0, Math.min(1, s.presence));
    }

    readonly property vector4d shape0: geometry(0)
    readonly property vector4d shape1: geometry(1)
    readonly property vector4d shape2: geometry(2)
    readonly property vector4d shape3: geometry(3)
    readonly property vector4d shape4: geometry(4)
    readonly property vector4d shape5: geometry(5)
    readonly property vector4d shape6: geometry(6)
    readonly property vector4d shape7: geometry(7)
    readonly property vector4d radii0: Qt.vector4d(corner(0), corner(1), corner(2), corner(3))
    readonly property vector4d radii1: Qt.vector4d(corner(4), corner(5), corner(6), corner(7))

    onShapesChanged: {
        if (shapes.length > 8)
            console.warn("LiquidGroup supports up to 8 shapes; additional shapes are ignored.");
    }
    fragmentShader: "../shaders/liquid.frag.qsb"
    onStatusChanged: {
        if (status === ShaderEffect.Error)
            console.error("LiquidGroup shader:", log);
    }
}
