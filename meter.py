# -*- coding: utf-8 -*-
import sys
sys.path.append('./xlrd/')
import os
import xlrd

def excel_meter(xlr, outdir):
    if not os.path.isdir(outdir):
        os.mkdir(outdir)

    data = xlrd.open_workbook(xlr)
    tables = data.sheets()

    for i in xrange(len(tables)):
        file_name = tables[i].name
        meta_name = tables[i].name

        elem = []
        for n in xrange(tables[i].ncols):
            elem.append((tables[i].cell(0,n).value, tables[i].cell(1,n).value))

        code = "/*this file is generate by meter for json*/\n\n"
        code += "{\n"
        for n in xrange(2, tables[i].nrows):
            code += "    \"" + str(tables[i].cell(n,0).value) + "\" : {"
            for m in xrange(tables[i].ncols):
                k,v = elem[m]
                if v == "string":
                    code += "\"" + k + "\":\"" + str(tables[i].cell(n,m).value) + "\""
                if v == "int":
                    code += "\"" + k + "\":" + str(int(tables[i].cell(n,m).value))
                if v == "bool":
                    code += "\"" + k + "\":" + str(tables[i].cell(n,m).value)
                if v == "float":
                    code += "\"" + k + "\":" + str(float(tables[i].cell(n,m).value))
                if m < (tables[i].ncols - 1):
                    code += ", "
                else:
                    code += ""
            if n < (tables[i].nrows - 1):
                code += "},\n"
            else:
                code += "}\n"
        code += "};\n"

        file = open(outdir + '//' + file_name + '.txt', 'w')
        file.write(code)
        file.close

if __name__=="__main__":
    excel_meter(sys.argv[1], sys.argv[2])
