---
publish: true
rkey: 3ml6ypek4wi2s
---

This is where the data lives that is used by apps like [bluesky](https://bsky.app), [leaflet](https://leaflet.pub), etc.

These notes are synced to [my PDS](https://pdsls.dev/at://did:plc:s7xw6pqvc72ha73bogjqp4m3/site.standard.publication/3ml5obpcbda2o#backlinks:site.standard.document) via the [obsidian-standard-site](https://github.com/SootyOwl/obsidian-standard-site) plugin. Since they exist as AT Records, they should be able to pick up backlinks via [constellation](https://constellation.microcosm.blue).

[[Digital Gardening]] is able to pick up a backlink from [this leaflet post](https://writing.drewmca.net/3ml5wpyblw226), but only because I directly copied in the at:// URI.  If I just link directly to `https://notes.drewmca.net/Digital-Gardening`, the records don't reference eachother.  If I try to link to `at://did:plc:...`, clicking the link in the web browser doesn't work.

I think what's missing here is some `http url -> at uri` resolution.  I'd like to be able to, within a leaflet or bsky post, just copy in the URL to this note.  Then, through the existing `<link rel=`
#### References
- https://atproto.com
- https://atprotocol.dev
- https://atmosphereaccount.com
