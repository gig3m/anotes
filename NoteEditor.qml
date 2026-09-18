import QtQuick
import QtQuick.Controls
import qs.Commons
import qs.Ui
import "Markdown.js" as Markdown

// The note itself: rendered to read, and its source to edit.
//
// The split is deliberate. Editing rendered text means reading formatting back
// out of the view and rebuilding Markdown from it, and Qt's rich text would
// make that a second parser -- one whose output nothing has checked against a
// real library. Markdown.js has that guarantee; a QTextDocument round trip
// would not, and the cost of being wrong is the user's note.
//
// So the rendered view is read-only and exact, and editing hands back the same
// text the daemon sent, unchanged unless the user changed it.
Item {
  id: root

  property bool readOnly: true
  property bool editing: false
  property string source: ""

  signal edited()

  function setDocument(md) {
    root.source = md
    root.editing = false
    area.text = md
    view.model = Markdown.parseDoc(md)
  }

  // Unchanged text comes back byte for byte: nothing is reconstructed unless
  // the user typed.
  function toMarkdown() { return root.editing ? area.text : root.source }

  // ---- rendered

  ScrollView {
    id: readScroll
    anchors.fill: parent
    visible: !root.editing
    clip: true

    Column {
      width: readScroll.width
      spacing: 0

      Repeater {
        id: view
        delegate: Row {
          width: readScroll.width
          leftPadding: modelData.depth * 24
          spacing: 0

          // The marker is drawn rather than left in the text, as Notes shows
          // it: a bullet, not "- ".
          Text {
            text: Markdown.markerFor(modelData.block)
            visible: text.length > 0
            color: Color.muted
            font.family: Style.fontFamily
            font.pixelSize: lineText.font.pixelSize
          }
          Text {
            id: lineText
            width: readScroll.width - (modelData.depth * 24) - (Markdown.markerFor(modelData.block).length ? 18 : 0)
            textFormat: Text.RichText
            wrapMode: Text.Wrap
            color: Color.foreground
            text: htmlFor(modelData)
            font.family: Style.fontFamily
            font.pixelSize: modelData.block === "title" ? Style.font.displayLarge
              : modelData.block === "heading" ? Style.font.display
              : modelData.block === "subhead" ? Style.font.title
              : Style.font.body
            font.bold: modelData.block === "title" || modelData.block === "heading"
              || modelData.block === "subhead"
            topPadding: modelData.block === "body" ? 0 : 6
            onLinkActivated: function (url) { Qt.openUrlExternally(url) }
            linkColor: Color.accent
          }
        }
      }
    }
  }

  // htmlFor styles one line. Read-only, so this never has to be parsed back --
  // which is why generating HTML here is safe and generating it for the editor
  // would not be.
  function htmlFor(line) {
    var out = ""
    for (var i = 0; i < line.spans.length; i++) {
      var sp = line.spans[i]
      var t = escapeHtml(sp.text)
      if (sp.style.code) t = "<code>" + t + "</code>"
      if (sp.style.sup) t = "<sup>" + t + "</sup>"
      if (sp.style.sub) t = "<sub>" + t + "</sub>"
      if (sp.style.strike) t = "<s>" + t + "</s>"
      if (sp.style.bold) t = "<b>" + t + "</b>"
      if (sp.style.italic) t = "<i>" + t + "</i>"
      if (sp.style.href !== undefined) t = "<a href=\"" + escapeHtml(sp.style.href) + "\">" + t + "</a>"
      out += t
    }
    return out.length ? out : "&nbsp;"
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;")
  }

  // ---- source

  ScrollView {
    anchors.fill: parent
    visible: root.editing
    clip: true

    TextArea {
      id: area
      wrapMode: TextArea.Wrap
      color: Color.foreground
      font.family: Style.fontFamily
      font.pixelSize: Style.font.body
      onTextChanged: if (root.editing) root.edited()
    }
  }

  // Clicking the rendered note starts editing it, unless it is not ours to
  // edit.
  MouseArea {
    anchors.fill: parent
    visible: !root.editing && !root.readOnly
    onClicked: { root.editing = true; area.forceActiveFocus() }
  }
}
