import json

from PIL import Image, ImageDraw

from server.cutout import face_box, key_cut


def test_face_box_is_json_safe_when_head_is_far_from_top():
    # Figure starts 200 px down, so the box top is not clamped to 0 (was numpy int64 there)
    img = Image.new("RGBA", (512, 768), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((200, 200, 312, 330), fill=(200, 180, 160, 255))
    ImageDraw.Draw(img).rectangle((150, 320, 362, 760), fill=(60, 60, 90, 255))
    box = face_box(img)
    assert box[1] > 0
    assert json.loads(json.dumps(list(box))) == list(box)


def test_key_cut_keeps_shirt_shading_but_clears_hair_gaps():
    # Pale green background (as FLUX draws it); a black-outlined figure holds a white shirt with light shading that
    # sits ~37 from the background (was punched out as a pocket) and a background-coloured gap between hair strands
    bg = (189, 218, 182)
    img = Image.new("RGB", (200, 300), bg)
    d = ImageDraw.Draw(img)
    d.rectangle((40, 40, 160, 260), fill=(20, 20, 30))
    d.rectangle((50, 50, 100, 250), fill=(245, 245, 250))
    d.rectangle((60, 80, 90, 120), fill=(200, 205, 212))  # shirt shading, distance ~37 from bg
    d.rectangle((115, 80, 145, 120), fill=(192, 216, 185))  # gap showing the background
    _, a = key_cut(img)
    assert a[100, 75] == 1.0
    assert a[100, 130] == 0.0
    assert a[5, 5] == 0.0
