import QtQuick
import QtQuick.Controls
import Quickshell
import Quickshell.Io
import qs.Commons
import qs.Ui
import "Client.js" as Client
import "Markdown.js" as Markdown

// Three panes, as Notes has them: folders, the notes in the selected folder,
// and the note itself.
//
// Colours come from Color, which reads the active theme's colors.toml, so this
// follows the desktop rather than carrying a palette of its own.
Panel {
  id: root
  moduleName: "gig3m.anotes"
  ipcTarget: "gig3m.anotes"

  property var anchorItem: null
  property var hostWidget: null

  property var folders: []
  property var notes: []
  property var current: null
  property string currentFolder: ""
  property string status: ""
  // Set when the user has taken responsibility for editing a note owned by
  // someone else. Per note, and cleared whenever another is opened: agreeing
  // once must not quietly apply to the next one.
  property bool allowShared: false
  property bool dirty: false

  readonly property bool readOnly: !current
    || current.sharedWithMe === true && !allowShared
    || (current.destroys || []).length > 0
    || (current.bodyError || "")

  function configure() {
    Client.base = root.setting("url", "") || urlFile.text().trim()
    Client.token = root.setting("token", "") || tokenFile.text().trim()
  }

  function refresh() {
    configure()
    Client.folders(function (list, err) {
      if (err) { root.status = err.message; return }
      root.folders = list || []
    })
    loadNotes()
  }

  function loadNotes() {
    Client.notes(root.currentFolder, function (list, err) {
      if (err) { root.status = err.message; return }
      root.status = ""
      root.notes = list || []
    })
  }

  function openNote(uuid) {
    Client.note(uuid, function (n, err) {
      if (err) { root.status = err.message; return }
      root.allowShared = false
      root.dirty = false
      root.current = n
      editor.setDocument(n.markdown || "")
    })
  }

  function save() {
    if (!root.current || root.readOnly) return
    var md = editor.toMarkdown()
    if (!md.trim().length) { root.status = "Refusing to empty the note."; return }
    Client.replace(root.current.uuid, md, root.allowShared, function (resp, err) {
      if (err) {
        root.status = err.destroys && err.destroys.length
          ? "Not saved — would remove " + err.destroys.join(", ")
          : "Not saved: " + err.message
        return
      }
      root.dirty = false
      root.status = (resp.degraded && resp.degraded.length)
        ? "Saved; flattened " + resp.degraded.join(", ")
        : "Saved."
    })
  }

  // The URL and token are read from the same files the notes CLI uses, so a
  // machine set up for one needs nothing further for the other.
  FileView { id: urlFile; path: Quickshell.env("HOME") + "/.config/applenotes/url" }
  FileView { id: tokenFile; path: Quickshell.env("HOME") + "/.config/applenotes/token" }

  onOpenedChanged: if (opened) refresh()

  // The popup surface every Omarchy panel uses: anchored to the bar button,
  // sized to its content, and closed by the shell's own key handling.
  KeyboardPanel {
    id: panel
    anchorItem: root.anchorItem
    owner: root
    bar: root.bar
    open: root.opened
    focusTarget: keyCatcher
    contentWidth: panel.fittedContentWidth(Style.space(1100))
    contentHeight: panel.fittedContentHeight(Style.space(700))

    PanelKeyCatcher {
      id: keyCatcher
      anchors.fill: parent
      onCloseRequested: root.close()
      onTabRequested: function (direction) { root.switchPanel(direction) }

    Row {
      anchors.fill: parent
      spacing: 0

      // ---- folders
      Rectangle {
        width: 180
        height: parent.height
        color: "transparent"

        Column {
          anchors.fill: parent
          anchors.margins: Style.space(2)
          spacing: Style.space(1)

          PanelSectionHeader { text: "Folders" }

          Repeater {
            model: [{ name: "All Notes", uuid: "" }].concat(root.folders.filter(f => !f.trash))
            delegate: Rectangle {
              width: parent.width
              height: 30
              radius: Style.cornerRadius
              color: root.currentFolder === modelData.uuid ? Color.menu.selectedBackground : "transparent"
              Text {
                anchors.verticalCenter: parent.verticalCenter
                anchors.left: parent.left
                anchors.leftMargin: Style.space(1)
                text: modelData.name
                color: Color.foreground
                elide: Text.ElideRight
                width: parent.width - Style.space(2)
              }
              MouseArea {
                anchors.fill: parent
                onClicked: { root.currentFolder = modelData.uuid; root.loadNotes() }
              }
            }
          }
        }
      }

      PanelSeparator { height: parent.height }

      // ---- the notes in it
      Rectangle {
        width: 280
        height: parent.height
        color: "transparent"

        Column {
          anchors.fill: parent
          anchors.margins: Style.space(2)
          spacing: Style.space(1)

          TextField {
            id: searchField
            width: parent.width
            placeholderText: "Search all notes"
            onTextChanged: {
              if (!text.trim().length) { root.loadNotes(); return }
              Client.search(text, function (hits, err) {
                if (err) { root.status = err.message; return }
                root.notes = (hits || []).map(h => h)
              })
            }
          }

          ScrollView {
            width: parent.width
            height: parent.height - searchField.height - Style.space(2)
            clip: true

            Column {
              width: parent.width
              spacing: 0

              Repeater {
                model: root.notes
                delegate: Rectangle {
                  width: parent.width
                  height: body.implicitHeight + Style.space(2)
                  radius: Style.cornerRadius
                  color: root.current && root.current.uuid === modelData.uuid
                    ? Color.menu.selectedBackground : "transparent"

                  Column {
                    id: body
                    anchors.left: parent.left
                    anchors.right: parent.right
                    anchors.verticalCenter: parent.verticalCenter
                    anchors.margins: Style.space(1)
                    spacing: 2

                    Text {
                      width: parent.width
                      text: (modelData.title || "").trim() || "Untitled"
                      color: Color.foreground
                      font.bold: true
                      elide: Text.ElideRight
                    }
                    Text {
                      text: (modelData.modified || "").split("T")[0]
                      color: Color.muted
                      font.pixelSize: Style.font.caption
                    }
                    // A note owned by someone else is read-only, so it is
                    // marked in the list rather than only once it is opened.
                    Text {
                      visible: text.length > 0
                      text: modelData.locked ? "Locked"
                        : modelData.sharedWithMe ? "Shared with you — read-only"
                        : modelData.shared ? "Shared" : ""
                      color: Color.muted
                      font.pixelSize: Style.font.caption
                    }
                  }

                  MouseArea {
                    anchors.fill: parent
                    onClicked: root.openNote(modelData.uuid)
                  }
                }
              }
            }
          }
        }
      }

      PanelSeparator { height: parent.height }

      // ---- the note
      Rectangle {
        width: parent.width - 180 - 280 - 2
        height: parent.height
        color: "transparent"

        Column {
          anchors.fill: parent
          anchors.margins: Style.space(2)
          spacing: Style.space(1)

          Row {
            width: parent.width
            spacing: Style.space(1)

            Text {
              width: parent.width - saveButton.width - editAnywayButton.width - Style.space(2)
              text: root.current ? ((root.current.title || "").trim() || "Untitled") : ""
              color: Color.foreground
              font.bold: true
              elide: Text.ElideRight
            }
            Button {
              id: editAnywayButton
              visible: root.current && root.current.sharedWithMe === true && !root.allowShared
              text: "Edit anyway"
              onClicked: root.allowShared = true
            }
            Button {
              id: saveButton
              text: "Save"
              enabled: root.dirty && !root.readOnly
              onClicked: root.save()
            }
          }

          // One short line. The owner is a CloudKit record id rather than a
          // name, so there is nothing more useful to say.
          Text {
            width: parent.width
            visible: text.length > 0
            wrapMode: Text.Wrap
            color: Color.muted
            text: !root.current ? ""
              : root.current.bodyError ? "Could not be read: " + root.current.bodyError
              : (root.current.sharedWithMe && !root.allowShared) ? "Owned by someone else — read-only"
              : (root.current.sharedWithMe && root.allowShared) ? "Editing a note you do not own — saving syncs it to them"
              : (root.current.destroys || []).length ? "Read-only: saving would remove " + root.current.destroys.join(", ")
              : (root.current.degrades || []).length ? "Saving will flatten " + root.current.degrades.join(", ") + " — no text is lost"
              : root.status
          }

          NoteEditor {
            id: editor
            width: parent.width
            height: parent.height - 60
            readOnly: root.readOnly
            onEdited: root.dirty = true
          }
        }
      }
    }
  }
  }
}
