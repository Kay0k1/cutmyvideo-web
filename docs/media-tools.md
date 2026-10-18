# Optional media helpers

The classic editor keeps its normal open → trim → export workflow. Helpers live
inside **Tools** and **Export settings** and start collapsed. Their names and
guidance are available in Russian and English, in both themes and on phones.
The collection workspace retains its existing controls.

## Review pauses, scenes and black intervals

Select the interval you want to inspect, then open **Tools**. Analysis requires
an uploaded recording and a selected interval of up to 30 minutes. Provider
links are not fetched for analysis. Requests can be cancelled; closing the
dialog, changing the source or selecting a different interval cancels pending
work and prevents late results from changing the current project.

**Pauses** prepares editable suggestions. Listen and review them: quiet speech
can be mistaken for a pause. Change boundaries or names and uncheck unwanted
suggestions before adding them. **Add selected** preserves existing clips and
their export selection. **Replace list…** asks for confirmation. Either apply
operation is one undoable edit. An unexamined audio tail is never silently
removed.

**Scenes and black frames** provides source-time navigation. It does not remove
black intervals. Scene boundaries can be converted into suggestions, reviewed
and applied through the same controls. These are visual thresholds, not scene
understanding.

## Exchange cuts and chapters

In **Tools → Cut lists**, open a UTF-8 CSV/FFmetadata file or paste its text.
**Check list** prepares a preview; it does not edit the project. CSV has no
header: `start seconds,end seconds,label`. Quoted labels, repeated intervals
and submitted order are retained. A missing end is shown expanded to the next
entry, or to the end of the source for the last marker. All boundaries remain
editable before applying. Files are limited to 1 MiB and 128 entries; the
server's clip and total-export limits also apply.

**Download CSV** and **Download chapters** use the current complete clip list
and source timestamps. FFmetadata requires chronological, non-overlapping
intervals; use CSV for repeated or reordered cuts. Finished joined files offer
**Download output chapters** inside their boundary/track details. Those chapters
use actual output timestamps from the completed file. Neither operation embeds
chapters into the media container.

## Adjust the exported file

Open **Export settings → More: sound and size**. A compact summary of
enabled enhancements remains visible in the export panel. The player and
waveform still show the original recording; these changes apply during export.

- **Loudness:** measure the selected source interval and optionally normalize
  the finished audio. Defaults are −16 LUFS, −1 dBTP and 11 LU. Silent metrics
  remain unmeasurable rather than appearing as a numeric zero. Normalization
  measures the actual selected/joined audio during export.
- **Canvas:** contain the picture in a vertical, square, landscape or custom
  even-sized canvas, with a solid background. The miniature explains the fit;
  it does not crop, stretch or automatically follow a person. A canvas requires
  accurate MP4 and best available quality.
- **Replacement audio:** choose an owned uploaded recording or upload one.
  Inspected audio tracks determine what is usable. A positive offset makes the
  recording start later on the original source timeline; a negative offset
  starts it earlier. The same source clock applies across joined/reordered
  ranges. Uncovered audio is padded with silence. Disconnecting a recording
  leaves its server file intact.

Normalization and replacement require accurate MP4/MP3 with subtitles omitted.
The interface explains conflicts and offers **Use compatible settings**; effects
are not silently discarded when another setting changes. Invalid values,
pending uploads and unavailable replacement recordings block a new export with
a corrective action. A previously submitted request can still be recovered
using its saved identity.

Settings survive a project reload. Replacement IDs belong to that project and
owner session; they do not become defaults for a different recording or travel
inside a portable JSON plan. Reattach the recording after importing such a plan.
Normal server retention and owner-only access remain in force.
