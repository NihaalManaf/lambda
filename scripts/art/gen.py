# Generates or edits art with OpenAI gpt-image-1.5 (/v1/images/edits: always sent a reference image, so the
# result matches the existing art). See style.md → loaders for the prompts that work.
# usage: OPENAI_API_KEY=… python3 -I scripts/art/gen.py jobs.json
#   jobs = [{out, ref, prompt, fidelity?: "low"|"high", size?: "1536x1024"|"1024x1024"|"1024x1536", opaque?: true}]
#   fidelity low = new scene in the reference's style; high = edit this exact image (pose frames)
import base64, json, os, sys, urllib.error, urllib.request, uuid, concurrent.futures as cf

KEY = os.environ["OPENAI_API_KEY"]


def run(j):
    b = uuid.uuid4().hex
    parts = []
    field = lambda k, v: parts.append(f'--{b}\r\nContent-Disposition: form-data; name="{k}"\r\n\r\n{v}\r\n'.encode())
    for k, v in [("model", "gpt-image-1.5"), ("prompt", j["prompt"]), ("size", j.get("size", "1536x1024")), ("background", "opaque" if j.get("opaque") else "transparent"),
                 ("output_format", "png"), ("quality", "high"), ("input_fidelity", j.get("fidelity", "low"))]:
        field(k, v)
    parts.append(f'--{b}\r\nContent-Disposition: form-data; name="image[]"; filename="ref.png"\r\nContent-Type: image/png\r\n\r\n'.encode() + open(j["ref"], "rb").read() + b"\r\n")
    parts.append(f"--{b}--\r\n".encode())
    req = urllib.request.Request("https://api.openai.com/v1/images/edits", data=b"".join(parts),
                                 headers={"Authorization": f"Bearer {KEY}", "Content-Type": f"multipart/form-data; boundary={b}"})
    try:
        d = json.load(urllib.request.urlopen(req, timeout=300))
        open(j["out"], "wb").write(base64.b64decode(d["data"][0]["b64_json"]))
        return j["out"], "ok"
    except urllib.error.HTTPError as e:
        return j["out"], e.read().decode()[:300]


with cf.ThreadPoolExecutor(6) as ex:
    for out, res in ex.map(run, json.load(open(sys.argv[1]))):
        print(out, res)
