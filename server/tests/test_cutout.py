import json

from PIL import Image, ImageDraw

from server.cutout import face_box


def test_face_box_is_json_safe_when_head_is_far_from_top():
    # Figure starts 200 px down, so the box top is not clamped to 0 (was numpy int64 there)
    img = Image.new("RGBA", (512, 768), (0, 0, 0, 0))
    ImageDraw.Draw(img).ellipse((200, 200, 312, 330), fill=(200, 180, 160, 255))
    ImageDraw.Draw(img).rectangle((150, 320, 362, 760), fill=(60, 60, 90, 255))
    box = face_box(img)
    assert box[1] > 0
    assert json.loads(json.dumps(list(box))) == list(box)
