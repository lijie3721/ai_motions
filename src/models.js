export function createDocumentAsset({ id, originalName, mimeType, filePath, slides, warnings }) {
  return {
    id,
    originalName,
    mimeType,
    filePath,
    createdAt: new Date().toISOString(),
    pageCount: slides.length,
    slides,
    warnings,
  };
}

export function createRenderJob({ id, documentAsset, storyboard, compositionPath, outputPath = null }) {
  return {
    id,
    status: "ready",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    documentAsset,
    storyboard,
    compositionPath,
    outputPath,
    renderer: null,
    error: null,
  };
}
