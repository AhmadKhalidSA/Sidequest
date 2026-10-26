"""Board reference lines for the lesson-mechanics ops in
overlay/board_extras.js. Spliced into the whiteboard reference."""

REFERENCE = """Lesson mechanics (the tutor's lesson flow, not for illustrations; the app places and styles these cards):
{"op":"boss","id":"boss","title":"<boss name>","hp":5,"max":5,"streak":0}   (end-of-section boss fight of 5 cumulative questions: a card in the top-right corner, so draw each question to its left. After each answer resend the same id with hp one lower for a hit and streak = answers right in a row; "defeated":true when it falls, "escaped":true if the questions run out. It stays across clears until it ends)
{"op":"checklist","id":"<id>","items":["<key point>","<key point>","<key point>"],"x":60,"y":110,"title":"<optional>"}   then {"op":"tick","list":"<id>","hit":[1,3],"miss":[2]}   (when the learner explains a section back: points start grey; hits get a green check, misses an amber "we'll revisit" mark; 1-based)
{"op":"rolecard","id":"<id>","scene":"<setting>","role":"<the learner's role>","character":"<who you play>","goal":"<what they must achieve>","phrases":["<useful phrase>","<useful phrase>"]}   (sets up a role-play; up to 3 phrases, in the target language if there is one)
{"op":"rapid","id":"rapid","n":1,"of":5,"streak":0,"secs":60}   (rapid-fire round: a slim bar under the title; its clock starts on the first show. Resend with the next n and the streak as each answer lands, then "done":true,"score":<right answers>)
Right-to-left text (Arabic, Hebrew...) in any op is laid out right to left automatically; write it in normal reading order.

"""
