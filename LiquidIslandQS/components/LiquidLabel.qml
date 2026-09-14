import QtQuick

// Content follows its owning shape; retirement hides it without a fade.
Text {
    required property LiquidShape shape
    x: shape.x
    y: shape.y
    width: shape.width
    height: shape.height
    horizontalAlignment: Text.AlignHCenter
    verticalAlignment: Text.AlignVCenter
    visible: !shape.retiring && width > 0 && height > 0
    clip: true
    color: "#f0f8fc"
    font.pixelSize: 17
    font.weight: Font.DemiBold
}
