const MAX_BYTES = 400 * 1024;
const MAX_LONG_SIDE = 640;

const fileInput = document.getElementById("fileInput");
const dropZone = document.getElementById("dropZone");
const resultSection = document.getElementById("resultSection");
const resultList = document.getElementById("resultList");
const clearButton = document.getElementById("clearButton");
const downloadAllButton = document.getElementById("downloadAllButton");

let results = [];

fileInput.addEventListener("change", () => {
  processFiles([...fileInput.files]);
  fileInput.value = "";
});

["dragenter", "dragover"].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.add("dragover");
  });
});

["dragleave", "drop"].forEach(eventName => {
  dropZone.addEventListener(eventName, event => {
    event.preventDefault();
    dropZone.classList.remove("dragover");
  });
});

dropZone.addEventListener("drop", event => {
  processFiles([...event.dataTransfer.files]);
});

clearButton.addEventListener("click", () => {
  results.forEach(item => URL.revokeObjectURL(item.url));
  results = [];
  resultList.innerHTML = "";
  resultSection.hidden = true;
  clearButton.hidden = true;
  downloadAllButton.disabled = true;
});

downloadAllButton.addEventListener("click", async () => {
  for (const item of results) {
    downloadBlob(item.blob, item.name);
    await wait(180);
  }
});

async function processFiles(files) {
  const imageFiles = files.filter(file => file.type.startsWith("image/"));

  if (!imageFiles.length) {
    alert("이미지 파일을 선택해주세요.");
    return;
  }

  resultSection.hidden = false;
  clearButton.hidden = false;

  for (const file of imageFiles) {
    const row = createProcessingRow(file);
    resultList.prepend(row.element);

    try {
      const compressed = await compressImage(file);
      const url = URL.createObjectURL(compressed.blob);

      const item = {
        blob: compressed.blob,
        url,
        name: compressed.name
      };

      results.push(item);
      updateRow(row, file, compressed, url);
    } catch (error) {
      console.error(error);
      showRowError(row, file, "변환에 실패했습니다.");
    }
  }

  downloadAllButton.disabled = results.length === 0;
}

function createProcessingRow(file) {
  const element = document.createElement("article");
  element.className = "result-item";
  element.innerHTML = `
    <div class="thumbnail"></div>
    <div>
      <p class="file-name"></p>
      <p class="file-info">변환 중...</p>
    </div>
    <button class="download-button" type="button" disabled>다운로드</button>
  `;

  element.querySelector(".file-name").textContent = file.name;

  const previewUrl = URL.createObjectURL(file);
  const image = document.createElement("img");
  image.className = "thumbnail";
  image.src = previewUrl;
  image.alt = "";
  image.onload = () => URL.revokeObjectURL(previewUrl);

  element.querySelector(".thumbnail").replaceWith(image);

  return {
    element,
    info: element.querySelector(".file-info"),
    button: element.querySelector(".download-button")
  };
}

function updateRow(row, original, compressed, url) {
  const originalSize = formatBytes(original.size);
  const compressedSize = formatBytes(compressed.blob.size);
  const reduction = original.size > 0
    ? Math.max(0, Math.round((1 - compressed.blob.size / original.size) * 100))
    : 0;

  row.info.innerHTML =
    `${originalSize} → ${compressedSize} · ${compressed.width}×${compressed.height}` +
    ` · <span class="success">${reduction}% 감소</span>`;

  row.button.disabled = false;
  row.button.addEventListener("click", () => {
    downloadBlob(compressed.blob, compressed.name);
  });
}

function showRowError(row, file, message) {
  row.info.innerHTML = `<span class="error">${message}</span>`;
}

async function compressImage(file) {
  const image = await loadImage(file);

  let { width, height } = getScaledSize(image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;

  const ctx = canvas.getContext("2d", { alpha: false });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, width, height);
  ctx.drawImage(image, 0, 0, width, height);

  // JPEG로 통일하면 용량 예측과 400KB 제한이 안정적입니다.
  // PNG 입력도 최종 결과는 JPG가 됩니다.
  let quality = 0.9;
  let blob = await canvasToBlob(canvas, quality);

  // 먼저 품질을 빠르게 낮추면서 400KB를 맞춥니다.
  for (let i = 0; i < 8 && blob.size > MAX_BYTES; i++) {
    quality -= 0.1;
    blob = await canvasToBlob(canvas, quality);
  }

  // 그래도 큰 경우 이진 탐색으로 가능한 가장 높은 품질을 찾습니다.
  if (blob.size > MAX_BYTES) {
    let low = 0.05;
    let high = Math.max(0.05, quality);

    for (let i = 0; i < 8; i++) {
      const mid = (low + high) / 2;
      const candidate = await canvasToBlob(canvas, mid);

      if (candidate.size <= MAX_BYTES) {
        blob = candidate;
        low = mid;
      } else {
        high = mid;
      }
    }
  }

  // 아주 복잡한 이미지에서 최소 품질로도 400KB를 넘는 경우를 대비합니다.
  // 해상도를 추가로 줄여 최종적으로 제한 안에 넣습니다.
  while (blob.size > MAX_BYTES && (width > 160 || height > 160)) {
    const scale = 0.85;
    width = Math.max(1, Math.round(width * scale));
    height = Math.max(1, Math.round(height * scale));

    canvas.width = width;
    canvas.height = height;
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);

    blob = await canvasToBlob(canvas, 0.82);
  }

  return {
    blob,
    width,
    height,
    name: makeOutputName(file.name)
  };
}

function getScaledSize(width, height) {
  const longSide = Math.max(width, height);

  if (longSide <= MAX_LONG_SIDE) {
    return { width, height };
  }

  const scale = MAX_LONG_SIDE / longSide;

  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale))
  };
}

function canvasToBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error("Blob 생성 실패")),
      "image/jpeg",
      quality
    );
  });
}

function loadImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      URL.revokeObjectURL(url);
      resolve(image);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("이미지를 읽을 수 없습니다."));
    };

    image.src = url;
  });
}

function makeOutputName(name) {
  const base = name.replace(/\.[^/.]+$/, "");
  return `${base}_compressed.jpg`;
}

function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");

  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}
