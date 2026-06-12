export function generateStoryboard(documentAsset) {
  const scenes = documentAsset.slides.map((slide, offset) => {
    const duration = estimateDuration(slide.text);
    return {
      id: `scene-${slide.index}`,
      slideIndex: slide.index,
      start: documentAsset.slides.slice(0, offset).reduce((sum, item) => sum + estimateDuration(item.text), 0),
      duration,
      title: slide.title,
      narration: buildNarration(slide),
      motion: offset % 2 === 0 ? "slow_zoom_in" : "pan_and_hold",
      transition: offset === 0 ? "fade_in" : "soft_wipe",
      highlights: pickHighlights(slide),
      slideImage: slide.imagePath,
    };
  });

  return {
    version: 1,
    title: documentAsset.originalName.replace(/\.[^.]+$/, ""),
    aspectRatio: "16:9",
    width: 1920,
    height: 1080,
    fps: 30,
    language: "zh-CN",
    duration: scenes.reduce((sum, scene) => sum + scene.duration, 0),
    scenes,
  };
}

function estimateDuration(text) {
  const length = String(text || "").replace(/\s+/g, "").length;
  return Math.min(9, Math.max(4, Math.ceil(length / 45) + 3));
}

function buildNarration(slide) {
  const body = compact(slide.body || slide.text);
  if (!body) {
    return `第 ${slide.index} 页聚焦「${slide.title}」，这里适合作为视频中的一个重点说明段落。`;
  }
  return `第 ${slide.index} 页是「${slide.title}」。${body.slice(0, 160)}${body.length > 160 ? "。" : ""}`;
}

function pickHighlights(slide) {
  const candidates = String(slide.text || "")
    .split(/\n|。|；|;/)
    .map((item) => item.trim())
    .filter((item) => item.length >= 4);

  return candidates.slice(0, 3);
}

function compact(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}
