"""Built-in generators. Importing this package registers every file type.

To add a new file type: create a module here, implement a ``Generator``, and
register it below. The CLI and the Go proxy need no changes.
"""

from muse_filegen.generators.docx import DocxGenerator, DocxReader
from muse_filegen.generators.pdf import PdfGenerator, PdfReader
from muse_filegen.generators.pptx import PptxGenerator, PptxReader
from muse_filegen.generators.xlsx import XlsxGenerator, XlsxReader
from muse_filegen.registry import register, register_reader

register(XlsxGenerator())
register(DocxGenerator())
register(PptxGenerator())
register(PdfGenerator())

register_reader(XlsxReader())
register_reader(DocxReader())
register_reader(PptxReader())
register_reader(PdfReader())
