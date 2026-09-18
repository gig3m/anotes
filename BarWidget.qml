import QtQuick
import Quickshell
import qs.Commons
import qs.Ui

// The bar entry. It owns nothing: the panel beside it holds the state, and this
// mirrors the structure every other Omarchy plugin uses so the shell can host
// it the same way.
BarWidget {
  id: root
  moduleName: "gig3m.anotes"

  function injectPanel() {
    var target = panelLoader.item
    if (!target) return
    if ("bar" in target) target.bar = root.bar
    if ("settings" in target) target.settings = root.settings
    if ("anchorItem" in target) target.anchorItem = button
    if ("hostWidget" in target) target.hostWidget = root
  }

  readonly property bool opened: panelLoader.item ? panelLoader.item.opened === true : false

  function togglePanel() { if (panelLoader.item) panelLoader.item.toggle() }
  function open() { if (panelLoader.item) panelLoader.item.open() }
  function close() { if (panelLoader.item) panelLoader.item.close() }

  implicitWidth: button.implicitWidth
  implicitHeight: button.implicitHeight

  onBarChanged: injectPanel()
  onSettingsChanged: injectPanel()

  Loader {
    id: panelLoader
    active: true
    source: Qt.resolvedUrl("Panel.qml")
    onLoaded: {
      root.injectPanel()
      Qt.callLater(root.injectPanel)
    }
  }

  BarIconButton {
    id: button
    anchors.fill: parent
    bar: root.bar
    // A nerd-font glyph, as the other bar widgets use: the bar renders one
    // icon font, so an image or an emoji would sit wrong beside them.
    text: "󰠮"
    tooltipText: "Notes"

    onPressed: function (mouseButton) {
      if (mouseButton === Qt.LeftButton) root.togglePanel()
    }
  }
}
