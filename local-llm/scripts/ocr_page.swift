// Local macOS Vision OCR for a single review page. No model/API calls.
// swift -module-cache-path /private/tmp/pm-swift-cache ocr_page.swift PDF PAGE OUTPUT.json
import AppKit
import Darwin
import Foundation
import PDFKit
import Vision

struct OCRLine: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}
struct OCRPage: Codable {
    let pdfPage: Int
    let engine: String
    let languages: [String]
    let lines: [OCRLine]
    let humanReviewed: Bool
}
enum IntakeError: Error { case arguments, pdfPage, image, koreanUnsupported, outputExists }

do {
    umask(0o077)
    guard CommandLine.arguments.count == 4,
          let pageNumber = Int(CommandLine.arguments[2]), pageNumber > 0 else {
        throw IntakeError.arguments
    }
    let source = URL(fileURLWithPath: CommandLine.arguments[1])
    let destination = URL(fileURLWithPath: CommandLine.arguments[3])
    guard !FileManager.default.fileExists(atPath: destination.path) else {
        throw IntakeError.outputExists
    }
    guard let document = PDFDocument(url: source),
          let page = document.page(at: pageNumber - 1) else { throw IntakeError.pdfPage }
    let bounds = page.bounds(for: .mediaBox)
    let thumbnail = page.thumbnail(of: NSSize(width: bounds.width * 3, height: bounds.height * 3), for: .mediaBox)
    guard let cgImage = thumbnail.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        throw IntakeError.image
    }
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    let supported = try request.supportedRecognitionLanguages()
    guard supported.contains("ko-KR") else { throw IntakeError.koreanUnsupported }
    request.recognitionLanguages = ["ko-KR", "en-US"]
    request.usesLanguageCorrection = true
    let handler = VNImageRequestHandler(cgImage: cgImage, options: [:])
    try handler.perform([request])
    let lines = (request.results ?? []).compactMap { observation -> OCRLine? in
        guard let best = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return OCRLine(text: best.string, confidence: best.confidence,
                       x: box.minX, y: box.minY, width: box.width, height: box.height)
    }
    let result = OCRPage(pdfPage: pageNumber, engine: "macOS Vision", languages: request.recognitionLanguages,
                         lines: lines, humanReviewed: false)
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
    try encoder.encode(result).write(to: destination, options: .withoutOverwriting)
    try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: destination.path)
    print("Local OCR complete: page \(pageNumber), \(lines.count) text regions. Human review still required.")
} catch {
    fputs("Local OCR failed (\(type(of: error))). Check the source page, output path and local Vision support.\n", stderr)
    exit(1)
}
