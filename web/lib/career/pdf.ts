// Client-only extraction. The original PDF never leaves the browser.
export async function resumeFileText(file: File) {
  if (file.size > 5 * 1024 * 1024)
    throw new Error('5MB 이하의 PDF 또는 텍스트 파일을 선택해주세요.');
  if (/\.txt$/i.test(file.name)) {
    const text = await file.text();
    if (text.length > 40000)
      throw new Error('이력서 내용은 40,000자 이내로 줄여주세요.');
    return text;
  }
  const data = new Uint8Array(await file.arrayBuffer());
  if (new TextDecoder().decode(data.slice(0, 5)) !== '%PDF-')
    throw new Error('PDF 또는 .txt 파일을 선택해주세요.');
  const pdf = await import('pdfjs-dist');
  pdf.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
  const task = pdf.getDocument({
    data,
    useSystemFonts: true,
    stopAtErrors: true,
  });
  // Abort encrypted files instead of leaving the loading promise waiting for a password.
  let interruption = '';
  task.onPassword = () => {
    interruption =
      '암호화된 PDF입니다. 암호를 해제하거나 내용을 직접 입력해주세요.';
    void task.destroy().catch(() => {});
  };
  const timer = setTimeout(() => {
    interruption = 'PDF 추출 시간이 초과됐습니다. 내용을 직접 입력해주세요.';
    void task.destroy().catch(() => {});
  }, 20000);
  try {
    const document = await task.promise;
    if (document.numPages > 30)
      throw new Error('30쪽 이하의 이력서를 선택해주세요.');
    let text = '';
    for (let i = 1; i <= document.numPages; i++) {
      const page = await document.getPage(i);
      const content = await page.getTextContent();
      text +=
        content.items
          .map((item) =>
            'str' in item ? item.str + (item.hasEOL ? '\n' : ' ') : '',
          )
          .join('') + '\n';
      page.cleanup();
      if (text.length > 40000)
        throw new Error(
          '추출한 내용이 40,000자를 넘습니다. 핵심 내용만 직접 입력해주세요.',
        );
    }
    if (!text.trim())
      throw new Error(
        '텍스트가 없는 스캔 PDF입니다. OCR은 지원하지 않으니 내용을 직접 입력해주세요.',
      );
    return text.trim();
  } catch (e) {
    if (interruption) throw new Error(interruption);
    if (e instanceof Error && /이력서|직접 입력|스캔 PDF/.test(e.message))
      throw e;
    throw new Error(
      'PDF를 읽지 못했습니다. 파일을 확인하거나 내용을 직접 입력해주세요.',
    );
  } finally {
    clearTimeout(timer);
    await task.destroy().catch(() => {});
  }
}
