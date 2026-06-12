export const HOTPOT_ASSETS = [
  {
    id: "hotpot-restaurant",
    type: "image",
    title: "火锅店门头",
    href: "/public/assets/hotpot/restaurant.jpg",
    filePath: "public/assets/hotpot/restaurant.jpg",
    keywords: ["开场", "门店", "招牌", "入口", "到店", "火锅店", "餐厅", "环境", "氛围", "高级"],
    source: "Wikimedia Commons",
  },
  {
    id: "hotpot-table",
    type: "image",
    title: "火锅桌面与锅底",
    href: "/public/assets/hotpot/hotpot-table.jpg",
    filePath: "public/assets/hotpot/hotpot-table.jpg",
    keywords: ["火锅", "锅底", "红油", "沸腾", "热气", "食材", "产品细节"],
    source: "Wikimedia Commons",
  },
  {
    id: "hotpot-family-dining",
    type: "image",
    title: "多人围坐用餐",
    href: "/public/assets/hotpot/family-dining.jpg",
    filePath: "public/assets/hotpot/family-dining.jpg",
    keywords: ["朋友", "聚餐", "人群", "碰杯", "热闹", "真实体验"],
    source: "Wikimedia Commons",
  },
  {
    id: "hotpot-ingredients",
    type: "image",
    title: "新鲜火锅食材",
    href: "/public/assets/hotpot/storefront.jpg",
    filePath: "public/assets/hotpot/storefront.jpg",
    keywords: ["食材", "海鲜", "新鲜", "虾", "产品细节"],
    source: "Wikimedia Commons",
  },
];

export function enrichStoryboardMedia(storyboard, brief) {
  if (!isHotpotProject(brief, storyboard)) return storyboard;
  return {
    ...storyboard,
    scenes: storyboard.scenes.map((scene, index) => ({
      ...scene,
      media: selectSceneMedia(scene, index),
    })),
  };
}

export function selectSceneMedia(scene, index = 0) {
  const haystack = [
    scene.title,
    scene.narration,
    scene.visualPrompt,
    ...(scene.highlights || []),
  ].join(" ");

  let best = null;
  let bestScore = -1;
  for (const asset of HOTPOT_ASSETS) {
    const score = asset.keywords.reduce((sum, keyword) => sum + (haystack.includes(keyword) ? 1 : 0), 0);
    if (score > bestScore) {
      best = asset;
      bestScore = score;
    }
  }

  if (bestScore <= 0) {
    best = [HOTPOT_ASSETS[0], HOTPOT_ASSETS[1], HOTPOT_ASSETS[2], HOTPOT_ASSETS[0]][index % 4];
  }

  return {
    type: best.type,
    assetId: best.id,
    title: best.title,
    href: best.href,
    filePath: best.filePath,
    source: best.source,
  };
}

function isHotpotProject(brief, storyboard) {
  const text = [
    brief?.subject,
    brief?.title,
    brief?.coreValue,
    storyboard?.title,
    ...(storyboard?.scenes || []).flatMap((scene) => [scene.title, scene.visualPrompt, ...(scene.highlights || [])]),
  ].join(" ");
  return /火锅|锅底|红油|涮/.test(text);
}
